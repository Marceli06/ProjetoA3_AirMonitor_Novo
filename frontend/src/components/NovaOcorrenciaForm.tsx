import { FormEvent, useState } from 'react';
import Icon from './Icon';
import DetailDrawer from './DetailDrawer';
import { CITIES } from './Register';
import { ocorrenciasAPI } from '../api';
import { Ocorrencia, TipoOcorrencia } from '../types';
import { LIMITES_FORM, ROTULO_TIPO, TIPOS_ORDEM, mensagemErroOcorrencia } from '../utils/ocorrencias';

interface NovaOcorrenciaFormProps {
  cidade: string; // USUARIO: a própria cidade; ADMIN: a cidade selecionada na tela (o backend valida as duas regras)
  onCancelar: () => void;
  onCriada: (ocorrencia: Ocorrencia) => void;
}

interface Campos {
  titulo: string;
  descricao: string;
  tipo: TipoOcorrencia | '';
  local: string;
  estacao: string;
}

type Erros = Partial<Record<keyof Campos, string>>;

const INICIAL: Campos = { titulo: '', descricao: '', tipo: '', local: '', estacao: '' };

const entre = (texto: string, { min, max }: { min: number; max: number }) => texto.length >= min && texto.length <= max;

// Mesmas regras do backend; ele continua sendo quem valida de verdade
function validar(c: Campos): Erros {
  const erros: Erros = {};
  if (!entre(c.titulo.trim(), LIMITES_FORM.titulo)) erros.titulo = `Informe o título (de ${LIMITES_FORM.titulo.min} a ${LIMITES_FORM.titulo.max} caracteres).`;
  if (!entre(c.descricao.trim(), LIMITES_FORM.descricao)) erros.descricao = `Informe a descrição (de ${LIMITES_FORM.descricao.min} a ${LIMITES_FORM.descricao.max} caracteres).`;
  if (c.tipo === '') erros.tipo = 'Selecione o tipo da ocorrência.';
  if (!entre(c.local.trim(), LIMITES_FORM.local)) erros.local = `Informe o local (de ${LIMITES_FORM.local.min} a ${LIMITES_FORM.local.max} caracteres).`;
  if (c.estacao.trim().length > LIMITES_FORM.estacao.max) erros.estacao = `A estação deve ter até ${LIMITES_FORM.estacao.max} caracteres.`;
  return erros;
}

export default function NovaOcorrenciaForm({ cidade, onCancelar, onCriada }: NovaOcorrenciaFormProps) {
  const [campos, setCampos] = useState<Campos>(INICIAL);
  const [erros, setErros] = useState<Erros>({});
  const [erroEnvio, setErroEnvio] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const alterar = <K extends keyof Campos>(campo: K, valor: Campos[K]) => {
    setCampos((atuais) => ({ ...atuais, [campo]: valor }));
    if (erros[campo]) setErros((atuais) => ({ ...atuais, [campo]: undefined }));
  };

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    const encontrados = validar(campos);
    setErros(encontrados);
    setErroEnvio(null);
    if (Object.keys(encontrados).length > 0 || campos.tipo === '') return;

    setEnviando(true);
    try {
      const { data } = await ocorrenciasAPI.criar({
        cidade,
        titulo: campos.titulo.trim(),
        descricao: campos.descricao.trim(),
        tipo: campos.tipo,
        local: campos.local.trim(),
        estacaoNome: campos.estacao.trim() || undefined,
      });
      onCriada(data.ocorrencia);
    } catch (erro) {
      setErroEnvio(mensagemErroOcorrencia(erro, 'registrar'));
    } finally {
      setEnviando(false);
    }
  };

  const regioes = CITIES[cidade] ?? [];

  return (
    <DetailDrawer
      titulo="Nova ocorrência"
      tituloId="nova-ocorrencia-titulo"
      testId="nova-ocorrencia"
      className="tom-total"
      icone={<Icon name="clipboard" />}
      etiqueta={<span className="oc-id">{cidade}</span>}
      onClose={onCancelar}
    >
      <form className="oc-form" onSubmit={enviar} noValidate data-testid="nova-ocorrencia-form">
        <p className="oc-form-note">Registre uma situação observada na qualidade do ar de <b>{cidade}</b>. Ela entra como “Em aberto” e é acompanhada pela equipe.</p>

        <div className="oc-field">
          <label htmlFor="oc-titulo">Título</label>
          <input
            id="oc-titulo"
            name="titulo"
            type="text"
            value={campos.titulo}
            maxLength={LIMITES_FORM.titulo.max}
            onChange={(e) => alterar('titulo', e.target.value)}
            aria-invalid={!!erros.titulo}
            aria-describedby={erros.titulo ? 'oc-titulo-erro' : undefined}
            placeholder="Ex.: Fumaça densa perto da avenida"
            autoComplete="off"
          />
          {erros.titulo && <small id="oc-titulo-erro" className="oc-field-error" role="alert">{erros.titulo}</small>}
        </div>

        <div className="oc-field">
          <label htmlFor="oc-descricao">Descrição</label>
          <textarea
            id="oc-descricao"
            name="descricao"
            rows={4}
            value={campos.descricao}
            maxLength={LIMITES_FORM.descricao.max}
            onChange={(e) => alterar('descricao', e.target.value)}
            aria-invalid={!!erros.descricao}
            aria-describedby={erros.descricao ? 'oc-descricao-erro' : undefined}
            placeholder="Descreva o que foi observado, quando e onde."
          />
          {erros.descricao && <small id="oc-descricao-erro" className="oc-field-error" role="alert">{erros.descricao}</small>}
        </div>

        <div className="oc-field">
          <label htmlFor="oc-tipo">Tipo</label>
          <select
            id="oc-tipo"
            name="tipo"
            value={campos.tipo}
            onChange={(e) => alterar('tipo', e.target.value as TipoOcorrencia | '')}
            aria-invalid={!!erros.tipo}
            aria-describedby={erros.tipo ? 'oc-tipo-erro' : undefined}
          >
            <option value="">Selecione…</option>
            {TIPOS_ORDEM.map((t) => (
              <option key={t} value={t}>{ROTULO_TIPO[t]}</option>
            ))}
          </select>
          {erros.tipo && <small id="oc-tipo-erro" className="oc-field-error" role="alert">{erros.tipo}</small>}
        </div>

        <div className="oc-field">
          <label htmlFor="oc-local">Local</label>
          <input
            id="oc-local"
            name="local"
            type="text"
            list="oc-locais"
            value={campos.local}
            maxLength={LIMITES_FORM.local.max}
            onChange={(e) => alterar('local', e.target.value)}
            aria-invalid={!!erros.local}
            aria-describedby={erros.local ? 'oc-local-erro' : undefined}
            placeholder="Bairro, rua ou ponto de referência"
            autoComplete="off"
          />
          <datalist id="oc-locais">
            {regioes.map((r) => (
              <option key={r} value={`${cidade} - ${r}`} />
            ))}
          </datalist>
          {erros.local && <small id="oc-local-erro" className="oc-field-error" role="alert">{erros.local}</small>}
        </div>

        <div className="oc-field">
          <label htmlFor="oc-estacao">Estação <span className="oc-optional">(opcional)</span></label>
          <input
            id="oc-estacao"
            name="estacao"
            type="text"
            value={campos.estacao}
            maxLength={LIMITES_FORM.estacao.max}
            onChange={(e) => alterar('estacao', e.target.value)}
            aria-invalid={!!erros.estacao}
            aria-describedby={erros.estacao ? 'oc-estacao-erro' : undefined}
            placeholder="Nome da estação de monitoramento próxima"
            autoComplete="off"
          />
          {erros.estacao && <small id="oc-estacao-erro" className="oc-field-error" role="alert">{erros.estacao}</small>}
        </div>

        {erroEnvio && <p className="oc-aviso is-erro" role="alert" data-testid="erro-formulario">{erroEnvio}</p>}

        <div className="oc-form-actions">
          <button type="submit" className="oc-btn is-primary" disabled={enviando} data-testid="registrar">
            {enviando ? 'Registrando…' : 'Registrar ocorrência'}
          </button>
          <button type="button" className="oc-btn" onClick={onCancelar} disabled={enviando}>Cancelar</button>
        </div>
      </form>
    </DetailDrawer>
  );
}
