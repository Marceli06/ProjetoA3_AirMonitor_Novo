import { Router, Request, Response } from 'express';
import pool from '../database';
import { authMiddleware } from '../middlewares';

const router = Router();

const POLUENTES = [
  { nome: 'PM2.5', descricao: 'Material particulado fino', valor: 12, unidade: 'µg/m³', status: 'Adequado' },
  { nome: 'PM10', descricao: 'Material particulado', valor: 18, unidade: 'µg/m³', status: 'Adequado' },
  { nome: 'O₃', descricao: 'Ozônio', valor: 64, unidade: 'µg/m³', status: 'Adequado' },
  { nome: 'NO₂', descricao: 'Dióxido de nitrogênio', valor: 22, unidade: 'µg/m³', status: 'Adequado' },
  { nome: 'CO', descricao: 'Monóxido de carbono', valor: 0.6, unidade: 'mg/m³', status: 'Adequado' },
  { nome: 'SO₂', descricao: 'Dióxido de enxofre', valor: 5, unidade: 'µg/m³', status: 'Adequado' },
];

const HISTORICO = [28, 35, 38, 44, 50, 54, 58, 63, 70, 86, 96, 90, 78, 72, 69, 66, 60, 52, 50, 50, 44, 38, 36, 34];

const ALERTAS_ADMIN = [
  { tipo: 'aviso', titulo: 'Qualidade moderada prevista', descricao: 'Aumento de O₃ nas próximas 24h.', data: '2026-09-10T14:20:00' },
  { tipo: 'ok', titulo: 'Sem alertas ativos', descricao: 'A qualidade do ar permanece estável na sua região.', data: '2026-09-10T09:15:00' },
  { tipo: 'info', titulo: 'Manutenção programada', descricao: 'Estação Centro - 12/09 das 08h às 12h.', data: '2026-09-09T18:40:00' },
  { tipo: 'aviso', titulo: 'Concentração elevada de PM10', descricao: 'Região Norte - Atenção.', data: '2026-09-09T11:30:00' },
];

const ALERTAS_USUARIO = [
  { tipo: 'aviso', titulo: 'Qualidade moderada prevista', descricao: 'Aumento de O₃ nas próximas 24h.', data: '2026-09-10T14:20:00' },
  { tipo: 'ok', titulo: 'Sem alertas ativos', descricao: 'A qualidade do ar permanece estável na sua região.', data: '2026-09-10T08:15:00' },
  { tipo: 'info', titulo: 'Manutenção programada', descricao: 'Estação Zona Leste - 12/09 das 08h às 12h.', data: '2026-09-08T16:30:00' },
];

const OCORRENCIAS_USUARIO = [
  { titulo: 'Buraco na via', descricao: 'Registrada em 09/09/2026', status: 'Aguardando análise' },
  { titulo: 'Queimada na região', descricao: 'Registrada em 05/09/2026', status: 'Em análise' },
  { titulo: 'Canteiro de obras', descricao: 'Registrada em 01/09/2026', status: 'Concluída' },
];

// Dados do dashboard: o bloco "gestao" só é enviado para ADMIN
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const ehAdmin = req.user?.perfil === 'ADMIN';

    const dados: Record<string, unknown> = {
      iqa: { valor: 32, classificacao: 'Boa', mensagem: 'A qualidade do ar está dentro dos níveis considerados adequados para a saúde.' },
      poluentes: POLUENTES,
      historico: HISTORICO,
      alertas: ehAdmin ? ALERTAS_ADMIN : ALERTAS_USUARIO,
    };

    if (ehAdmin) {
      const total = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios');
      dados.gestao = { totalUsuarios: total.rows[0].total };
    } else {
      dados.ocorrencias = OCORRENCIAS_USUARIO;
    }

    res.json(dados);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao carregar o dashboard' });
  }
});

export default router;