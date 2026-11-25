import dotenv from 'dotenv';

dotenv.config();

// Segredo de assinatura dos tokens. Sem ele o servidor não sobe: um valor padrão embutido no código permitiria
// forjar tokens de qualquer perfil (inclusive ADMIN) em um ambiente mal configurado.
const segredo = (process.env.JWT_SECRET || '').trim();

if (!segredo) {
  throw new Error('JWT_SECRET não definido. Configure-o em backend/.env (veja backend/.env.example).');
}

if (segredo.length < 32) {
  console.warn('[config] JWT_SECRET curto: use um valor aleatório com pelo menos 32 caracteres fora do desenvolvimento.');
}

export const JWT_SECRET = segredo;
