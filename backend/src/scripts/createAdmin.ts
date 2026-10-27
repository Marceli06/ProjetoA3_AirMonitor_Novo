import bcrypt from 'bcryptjs';
import pool from '../database';

// Cria o primeiro ADMIN. Uso: ADMIN_EMAIL=... ADMIN_SENHA=... ADMIN_NOME=... npm run admin:create
// Se o e-mail já existir, não altera nada.
async function main() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const senha = process.env.ADMIN_SENHA || '';
  const nome = process.env.ADMIN_NOME || 'Administrador';

  if (!email || senha.length < 8) {
    throw new Error('Defina ADMIN_EMAIL e ADMIN_SENHA (senha com no mínimo 8 caracteres).');
  }

  const existente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
  if (existente.rows.length > 0) {
    console.log(`Já existe um usuário com o e-mail ${email}. Nada foi alterado.`);
    return;
  }

  const senhaHash = await bcrypt.hash(senha, 12);
  await pool.query(
    "INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, 'ADMIN', TRUE)",
    [nome, email, senhaHash]
  );
  console.log(`ADMIN criado com sucesso: ${email}`);
}

main()
  .catch((err) => {
    console.error('Erro ao criar ADMIN:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());