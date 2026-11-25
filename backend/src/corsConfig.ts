import { CorsOptions } from 'cors';
import dotenv from 'dotenv';

dotenv.config();

// Origens autorizadas a chamar a API a partir de um navegador.
// - Produção (NODE_ENV=production): somente as URLs de FRONTEND_URL (várias, separadas por vírgula).
// - Fora da produção: FRONTEND_URL e também qualquer porta de localhost / 127.0.0.1 (Vite, testes locais).
// Requisições sem cabeçalho Origin (health check do Render, curl, scripts de validação) não passam por CORS.
const normalizar = (origem: string) => origem.trim().replace(/\/+$/, '');

export const origensPermitidas = (process.env.FRONTEND_URL || '').split(',').map(normalizar).filter(Boolean);

const emProducao = process.env.NODE_ENV === 'production';
const ORIGEM_LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

if (emProducao && origensPermitidas.length === 0) {
  console.warn('[cors] FRONTEND_URL não definido: nenhum navegador conseguirá chamar a API em produção.');
}

export const corsOptions: CorsOptions = {
  origin(origem, callback) {
    if (!origem) return callback(null, true);
    const o = normalizar(origem);
    callback(null, origensPermitidas.includes(o) || (!emProducao && ORIGEM_LOCAL.test(o)));
  },
  maxAge: 600, // o navegador reaproveita o preflight por 10 min
};
