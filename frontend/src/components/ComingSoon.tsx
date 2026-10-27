import './ComingSoon.css';

interface ComingSoonProps {
  onBack: () => void;
}

export default function ComingSoon({ onBack }: ComingSoonProps) {
  return (
    <div className="coming-soon-container">
      {/* Header */}
      <header className="coming-soon-header">
        <div className="logo-section">
          <div className="logo-icon">
            <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
              <rect width="100" height="100" rx="15" fill="#E6F4FF" />
              <path d="M40 60 Q40 40, 50 35 Q60 40, 60 60" fill="#0099CC" />
              <path d="M60 60 Q60 40, 70 35 Q80 40, 80 60" fill="#00CC99" />
            </svg>
          </div>
          <span className="logo-text">AirMonitor</span>
        </div>
        <nav className="header-nav">
          <a href="#">Sobre</a>
          <a href="#">Recursos</a>
          <a href="#">Ajuda</a>
        </nav>
      </header>

      {/* Main Content */}
      <main className="coming-soon-main">
        <div className="coming-soon-card">
          <div className="coming-soon-icon">
            <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="45" fill="none" stroke="#E8D5F2" strokeWidth="2" />
              <text x="50" y="60" fontSize="40" fontWeight="bold" textAnchor="middle" fill="#667eea">
                ⏳
              </text>
            </svg>
          </div>

          <h1>Em Breve</h1>
          <p className="subtitle">
            A funcionalidade de criação de conta será desenvolvida em breve. Fique atento para as atualizações!
          </p>

          <div className="features-list">
            <div className="feature-item">
              <div className="feature-icon">✓</div>
              <span>Cadastro simples e rápido</span>
            </div>
            <div className="feature-item">
              <div className="feature-icon">✓</div>
              <span>Verificação de e-mail</span>
            </div>
            <div className="feature-item">
              <div className="feature-icon">✓</div>
              <span>Acesso instantâneo ao AirMonitor</span>
            </div>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            onClick={onBack}
          >
            Voltar para o Login
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer className="coming-soon-footer">
        <p>&copy; 2024 AirMonitor. Todos os direitos reservados.</p>
        <p>Um ar melhor para um futuro mais saudável.</p>
      </footer>
    </div>
  );
}
