# AirMonitor

Sistema web para acompanhar a **qualidade do ar de cidades do estado de São Paulo** com dados reais da **OpenAQ** (estações) e da **Open-Meteo** (modelo, como complemento), com **alertas**, **ocorrências** ambientais e **histórico** de medições. Dois perfis: USUARIO (própria cidade) e ADMIN (todas as cidades e a administração do sistema).

- Frontend: React 18 + TypeScript + Vite + axios
- Backend: Node.js + Express + TypeScript + `pg`
- Banco: PostgreSQL (Supabase)

## Execução rápida

```bash
# Backend
cd backend
npm install
cp .env.example .env      # preencha DATABASE_URL, JWT_SECRET e OPENAQ_API_KEY (o .env nunca vai para o Git)
npm run db:migrate
ADMIN_EMAIL=admin@exemplo.com ADMIN_SENHA='uma-senha-forte' npm run admin:create
npm run dev               # http://localhost:3000

# Frontend (outro terminal)
cd frontend
npm install
npm run dev               # http://localhost:5173
```

## Validação

```bash
cd backend && npx tsc --noEmit && npm run validate:all   # 8 suítes de API/banco
cd backend && npm run ui:validate                         # interface em navegador real (UI_BROWSERS=chrome,edge)
cd frontend && npx tsc --noEmit && npm run build
```

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [`docs/DOCUMENTACAO_FINAL.md`](docs/DOCUMENTACAO_FINAL.md) | objetivo, arquitetura, tecnologias, perfis, banco, integrações, segurança, falhas, limitações, execução e rastreabilidade de requisitos |
| [`docs/TESTES.md`](docs/TESTES.md) | matriz de testes, resultados finais e defeitos encontrados/corrigidos |
| [`docs/APRESENTACAO.md`](docs/APRESENTACAO.md) | roteiro de apresentação de ~5 minutos |
| [`backend/docs/ALERTAS.md`](backend/docs/ALERTAS.md) | regras, limiares provisórios e API de Alertas |
| [`backend/docs/OCORRENCIAS.md`](backend/docs/OCORRENCIAS.md) | tabela, API e permissões de Ocorrências |
| [`backend/docs/HISTORICO.md`](backend/docs/HISTORICO.md) | API e fontes do Histórico |

## Limitações conhecidas (resumo)

Limiares de alerta provisórios (sem IQA); alertas gerados só pela avaliação do ADMIN; sem integração Alertas → Ocorrências; "Esqueci a senha" não envia e-mail; CORS aberto e sem limite de tentativas de login; Firefox não testado. Lista completa em `docs/DOCUMENTACAO_FINAL.md`, seção 14.
