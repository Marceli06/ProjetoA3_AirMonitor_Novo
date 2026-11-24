import { ReactNode, useEffect, useRef } from 'react';
import Icon from './Icon';
import './DetailDrawer.css';

interface DetailDrawerProps {
  titulo: string;
  tituloId: string; // id do título, usado em aria-labelledby
  testId: string; // gera data-testid "<testId>-detalhe" e "<testId>-overlay"
  className?: string; // classe de tom (define --tom, --tom-bg) aplicada ao painel
  icone: ReactNode;
  etiqueta?: ReactNode; // linha acima do título (poluente, ID...)
  onClose: () => void;
  children: ReactNode;
}

// Painel lateral modal de detalhes. Fecha pelo X, pelo botão "Fechar", pelo fundo e pela tecla Esc;
// leva o foco para o botão X ao abrir e devolve ao elemento anterior ao fechar.
export default function DetailDrawer({ titulo, tituloId, testId, className = '', icone, etiqueta, onClose, children }: DetailDrawerProps) {
  const botaoFecharRef = useRef<HTMLButtonElement>(null);
  const aoFecharRef = useRef(onClose);
  aoFecharRef.current = onClose;

  useEffect(() => {
    const anterior = document.activeElement as HTMLElement | null;
    botaoFecharRef.current?.focus();
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') aoFecharRef.current();
    };
    document.addEventListener('keydown', aoTeclar);
    return () => {
      document.removeEventListener('keydown', aoTeclar);
      if (anterior && document.contains(anterior)) anterior.focus();
    };
  }, []);

  return (
    <div className="detail-overlay" onClick={onClose} data-testid={`${testId}-overlay`}>
      <aside
        className={`detail-drawer ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        onClick={(e) => e.stopPropagation()}
        data-testid={`${testId}-detalhe`}
      >
        <header className="detail-head">
          <span className="detail-head-icon">{icone}</span>
          <div>
            {etiqueta}
            <h2 id={tituloId}>{titulo}</h2>
          </div>
          <button ref={botaoFecharRef} type="button" className="detail-close" onClick={onClose} aria-label="Fechar detalhes">
            <Icon name="close" />
          </button>
        </header>

        {children}

        <button type="button" className="detail-done" onClick={onClose}>Fechar</button>
      </aside>
    </div>
  );
}
