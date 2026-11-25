import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import airQualityRoutes from './routes/airQuality';
import alertasRoutes from './routes/alertas';
import ocorrenciasRoutes from './routes/ocorrencias';
import historicoRoutes from './routes/historico';
import { errorHandler } from './middlewares';
import { corsOptions } from './corsConfig';
import pool from './database';

dotenv.config();

const app = express();
// No Render a porta vem de process.env.PORT; 3000 é só o padrão local
const PORT = Number(process.env.PORT) || 3000;

// Middlewares
app.use(cors(corsOptions));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// Database connection test
app.get('/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ success: true, timestamp: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Erro de conexão com banco' });
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/air-quality', airQualityRoutes);
app.use('/api/alertas', alertasRoutes);
app.use('/api/ocorrencias', ocorrenciasRoutes);
app.use('/api/historico', historicoRoutes);

// Error handler
app.use(errorHandler);

// Iniciar servidor
// 0.0.0.0: necessário para o proxy do Render alcançar o processo dentro do contêiner
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
