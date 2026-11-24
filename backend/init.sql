-- Tabela legada (mantida; o sistema passa a usar a tabela usuarios)
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(20) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Usuários do sistema com perfil (ADMIN ou USUARIO)
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  senha_hash VARCHAR(255) NOT NULL,
  perfil VARCHAR(10) NOT NULL DEFAULT 'USUARIO' CHECK (perfil IN ('ADMIN', 'USUARIO')),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  cidade VARCHAR(80),
  regiao VARCHAR(80),
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Alertas de qualidade do ar gerados pelo backend a partir dos dados da OpenAQ e da Open-Meteo.
-- No máximo um alerta ATIVO por (cidade, estação, poluente). Regras e estratégia: backend/docs/ALERTAS.md
CREATE TABLE IF NOT EXISTS alertas (
  id SERIAL PRIMARY KEY,
  cidade VARCHAR(80) NOT NULL,
  regiao VARCHAR(80),
  estacao_id VARCHAR(40) NOT NULL,
  estacao_nome VARCHAR(255),
  poluente VARCHAR(10) NOT NULL CHECK (poluente IN ('pm25', 'pm10', 'o3', 'no2', 'co', 'so2')),
  valor DOUBLE PRECISION NOT NULL CHECK (valor >= 0),
  unidade VARCHAR(20) NOT NULL,
  nivel VARCHAR(10) NOT NULL CHECK (nivel IN ('BAIXO', 'MODERADO', 'ALTO', 'CRITICO')),
  titulo VARCHAR(160) NOT NULL,
  descricao TEXT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO', 'RESOLVIDO')),
  origem_dado VARCHAR(20) NOT NULL CHECK (origem_dado IN ('OPENAQ', 'OPEN_METEO')),
  tipo_dado VARCHAR(10) NOT NULL CHECK (tipo_dado IN ('MEDICAO', 'MODELO')),
  medicao_em TIMESTAMPTZ NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolvido_em TIMESTAMPTZ,
  -- Estimativa de modelo nunca pode ser gravada como medição de estação (nem o contrário)
  CONSTRAINT ck_alertas_origem_tipo CHECK (
    (origem_dado = 'OPENAQ' AND tipo_dado = 'MEDICAO') OR (origem_dado = 'OPEN_METEO' AND tipo_dado = 'MODELO')
  ),
  -- resolvido_em só existe (e sempre existe) em alerta RESOLVIDO
  CONSTRAINT ck_alertas_resolucao CHECK ((status = 'RESOLVIDO') = (resolvido_em IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_alertas_cidade ON alertas(cidade);
CREATE INDEX IF NOT EXISTS idx_alertas_status ON alertas(status);
CREATE INDEX IF NOT EXISTS idx_alertas_poluente ON alertas(poluente);
CREATE INDEX IF NOT EXISTS idx_alertas_medicao_em ON alertas(medicao_em DESC);
-- Trava de duplicidade: só um alerta ATIVO por cidade + estação + poluente
CREATE UNIQUE INDEX IF NOT EXISTS uq_alertas_ativo ON alertas(cidade, estacao_id, poluente) WHERE status = 'ATIVO';