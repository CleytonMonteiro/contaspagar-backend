// 1. Importando as bibliotecas necessárias
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

// 2. Carregando as credenciais do Firebase
const serviceAccount = require('./firebase-credentials.json');

// 3. Inicializando o Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// 4. Inicializando o Express
const app = express();

// 5. Configurações do Express
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// ========================================
//   ROTAS DA API (CRUD)
// ========================================

app.get('/', (req, res) => {
  res.send('Olá! O backend do Contas a Pagar está no ar!');
});

/**
 * ROTA PARA BUSCAR TODAS AS CONTAS (READ)
 */
app.get('/api/contas', async (req, res) => {
  try {
    const { q } = req.query;
    const contasRef = db.collection('contas');
    const snapshot = await contasRef.orderBy('dataVencimento', 'asc').get();

    if (snapshot.empty) {
      return res.status(200).json([]);
    }

    let contas = [];
    snapshot.forEach(doc => {
      contas.push({
        id: doc.id,
        ...doc.data()
      });
    });

    if (q) {
      const termoBuscaLower = q.toLowerCase();
      const contasFiltradas = contas.filter(conta => 
        (conta.fornecedor || '').toLowerCase().includes(termoBuscaLower) ||
        (conta.historico || '').toLowerCase().includes(termoBuscaLower) ||
        (conta.notaFiscal || '').toLowerCase().includes(termoBuscaLower)
      );
      return res.status(200).json(contasFiltradas);
    }
    
    res.status(200).json(contas);

  } catch (error) {
    console.error("Erro ao buscar contas: ", error);
    res.status(500).send('Erro ao buscar contas no banco de dados.');
  }
});

/**
 * ROTA PARA CRIAR UMA NOVA CONTA (CREATE)
 */
app.post('/api/contas', async (req, res) => {
  try {
    const { fornecedor, historico, notaFiscal, valorPagar, dataVencimento, dataEmissao } = req.body;
    const numeroParcelas = parseInt(req.body.numeroParcelas, 10) || 1;

    if (notaFiscal && fornecedor) {
      const query = db.collection('contas')
        .where('notaFiscal', '==', notaFiscal)
        .where('fornecedor', '==', fornecedor)
        .limit(1);
      
      const snapshot = await query.get();

      if (!snapshot.empty) {
        return res.status(409).json({ message: `Erro: A Nota Fiscal nº ${notaFiscal} já foi cadastrada para o fornecedor "${fornecedor}".` });
      }
    }

    if (!fornecedor || !valorPagar || !dataVencimento) {
      return res.status(400).send('Erro: Fornecedor, Valor a Pagar e Data de Vencimento são obrigatórios.');
    }

    if (numeroParcelas === 1) {
      const novaConta = { fornecedor, historico, notaFiscal, valorPagar: Number(valorPagar), repassadoFinanceiro: false, dataRepasse: null, dataVencimento: admin.firestore.Timestamp.fromDate(new Date(dataVencimento)), dataEmissao: admin.firestore.Timestamp.fromDate(new Date(dataEmissao)), parcelaAtual: 1, totalParcelas: 1 };
      const docRef = await db.collection('contas').add(novaConta);
      res.status(201).send({ ids: [docRef.id] });
    } else {
      const batch = db.batch();
      const grupoParcelaId = Date.now().toString();
      const primeiraDataVencimento = new Date(dataVencimento);
      for (let i = 1; i <= numeroParcelas; i++) {
        const vencimentoAtual = new Date(primeiraDataVencimento);
        vencimentoAtual.setMonth(vencimentoAtual.getMonth() + (i - 1));
        const novaParcela = { fornecedor, historico, notaFiscal, valorPagar: Number(valorPagar), repassadoFinanceiro: false, dataRepasse: null, dataVencimento: admin.firestore.Timestamp.fromDate(vencimentoAtual), dataEmissao: admin.firestore.Timestamp.fromDate(new Date(dataEmissao)), parcelaAtual: i, totalParcelas: numeroParcelas, grupoParcela: grupoParcelaId };
        const docRef = db.collection('contas').doc();
        batch.set(docRef, novaParcela);
      }
      await batch.commit();
      res.status(201).send({ message: `${numeroParcelas} parcelas criadas com sucesso.` });
    }
  } catch (error) {
    console.error("Erro ao criar conta(s): ", error);
    res.status(500).send('Erro ao salvar conta(s) no banco de dados.');
  }
});

/**
 * ROTA PARA ATUALIZAR UMA CONTA (UPDATE)
 */
app.put('/api/contas/:id', async (req, res) => {
  try {
    const contaId = req.params.id;
    const { repassado } = req.body;
    if (typeof repassado !== 'boolean') {
      return res.status(400).send({ message: 'O campo "repassado" (do tipo booleano) é obrigatório.' });
    }
    const contaRef = db.collection('contas').doc(contaId);
    const dadosAtualizados = {
      repassadoFinanceiro: repassado,
      dataRepasse: repassado ? admin.firestore.FieldValue.serverTimestamp() : null
    };
    await contaRef.update(dadosAtualizados);
    res.status(200).send({ message: `Conta ${contaId} atualizada com sucesso.` });
  } catch (error) {
    console.error("Erro ao atualizar conta: ", error);
    res.status(500).send('Erro ao atualizar conta no banco de dados.');
  }
});

/**
 * ROTA PARA DELETAR UMA CONTA (DELETE - COM EXCLUSÃO EM CASCATA PARA PARCELAS)
 */
app.delete('/api/contas/:id', async (req, res) => {
  try {
    const contaId = req.params.id;
    const contaRef = db.collection('contas').doc(contaId);
    
    const doc = await contaRef.get();
    if (!doc.exists) {
      return res.status(404).send({ message: 'Conta não encontrada.' });
    }

    const contaData = doc.data();
    
    if (contaData.grupoParcela && contaData.totalParcelas > 1) {
      console.log(`Conta parcelada detectada. Excluindo grupo: ${contaData.grupoParcela}`);
      
      const query = db.collection('contas').where('grupoParcela', '==', contaData.grupoParcela);
      const snapshot = await query.get();

      if (snapshot.empty) {
        await contaRef.delete();
        return res.status(200).send({ message: `Conta ${contaId} (órfã) deletada com sucesso.` });
      }

      const batch = db.batch();
      snapshot.forEach(doc => {
        batch.delete(doc.ref);
      });
      await batch.commit();
      
      return res.status(200).send({ message: `${snapshot.size} parcelas do grupo ${contaData.grupoParcela} foram deletadas com sucesso.` });

    } else {
      await contaRef.delete();
      return res.status(200).send({ message: `Conta ${contaId} deletada com sucesso.` });
    }

  } catch (error) {
    console.error("Erro ao deletar conta: ", error);
    res.status(500).send('Erro ao deletar conta no banco de dados.');
  }
});

// ========================================
//   INICIALIZAÇÃO DO SERVIDOR
// ========================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}!`);
});