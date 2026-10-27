import fs from 'fs';
import path from 'path';
import pool from '../database';

// Aplica o init.sql (CREATE ... IF NOT EXISTS). Não apaga dados.
async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'init.sql'), 'utf8');
  await pool.query(sql);
  console.log('Banco atualizado a partir do init.sql.');
}

main()
  .catch((err) => {
    console.error('Erro ao atualizar o banco:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());