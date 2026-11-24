import Icon from './Icon';
import { formatarDataHora } from '../utils/formatar';
import './CidadeEData.css';

interface CidadeEDataProps {
  cidades: string[]; // ADMIN: todas as cidades suportadas; USUARIO: somente a própria
  cidade: string;
  onCidadeChange: (cidade: string) => void;
  atualizadoEm: Date;
}

// Cidade (seletor para o ADMIN, rótulo fixo para o USUARIO) e data/hora da última atualização, no padrão do Dashboard
export default function CidadeEData({ cidades, cidade, onCidadeChange, atualizadoEm }: CidadeEDataProps) {
  return (
    <div className="dash-filters">
      {cidades.length > 1 ? (
        <label className="dash-select">
          <Icon name="pin" />
          <select aria-label="Cidade" value={cidade} onChange={(e) => onCidadeChange(e.target.value)}>
            {cidades.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <Icon name="dropdown" />
        </label>
      ) : (
        <div className="dash-select page-city-fixed" aria-label="Cidade">
          <Icon name="pin" />
          <strong>{cidade}</strong>
        </div>
      )}
      <div className="dash-date">
        <Icon name="calendar" />
        <div>
          <strong>{formatarDataHora(atualizadoEm.toISOString())}</strong>
          <small>Última atualização</small>
        </div>
      </div>
    </div>
  );
}
