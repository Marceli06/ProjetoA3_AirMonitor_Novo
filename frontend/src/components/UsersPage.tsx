import { useEffect, useState } from 'react';
import { adminAPI } from '../api';
import { UsuarioAdmin } from '../types';
import './UsersPage.css';

interface FormState {
  nome: string;
  email: string;
  password: string;
  cidade: string;
  regiao: string;
}

type ModalState = { mode: 'create' } | { mode: 'edit'; usuario: UsuarioAdmin } | null;

const EMPTY_FORM: FormState = { nome: '', email: '', password: '', cidade: '', regiao: '' };

const erroDaApi = (err: any, padrao: string) => err?.response?.data?.error || padrao;

const formatarData = (valor: string) =>
  new Date(valor).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

const idDoUsuarioLogado = (): number | null => {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null')?.id ?? null;
  } catch {
    return null;
  }
};

export default function UsersPage() {
  const [usuarios, setUsuarios] = useState<UsuarioAdmin[]>([]);
  const [cidades, setCidades] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<ModalState>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const meuId = idDoUsuarioLogado();

  const carregar = async () => {
    setError('');
    setLoading(true);
    try {
      const [listaRes, cidadesRes] = await Promise.all([adminAPI.listarUsuarios(), adminAPI.listarCidades()]);
      setUsuarios(listaRes.data);
      setCidades(cidadesRes.data);
    } catch (err: any) {
      setError(erroDaApi(err, 'Erro ao carregar usuários'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    carregar();
  }, []);

  const abrirCriar = () => {
    setForm(EMPTY_FORM);
    setFormError('');
    setModal({ mode: 'create' });
  };

  const abrirEditar = (u: UsuarioAdmin) => {
    setForm({ nome: u.nome, email: u.email, password: '', cidade: u.cidade || '', regiao: u.regiao || '' });
    setFormError('');
    setModal({ mode: 'edit', usuario: u });
  };

  const fecharModal = () => {
    if (!saving) setModal(null);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setForm((prev) => (name === 'cidade' ? { ...prev, cidade: value, regiao: '' } : { ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modal) return;
    setFormError('');
    setSaving(true);

    const { nome, email, cidade, regiao, password } = form;
    try {
      if (modal.mode === 'create') {
        await adminAPI.criarUsuario({ nome, email, cidade, regiao, password });
        setNotice('Usuário criado com sucesso.');
      } else {
        await adminAPI.atualizarUsuario(modal.usuario.id, { nome, email, cidade, regiao });
        setNotice('Usuário atualizado com sucesso.');
      }
      setModal(null);
      await carregar();
    } catch (err: any) {
      setFormError(erroDaApi(err, 'Erro ao salvar usuário'));
    } finally {
      setSaving(false);
    }
  };

  const alternarStatus = async (u: UsuarioAdmin) => {
    const acao = u.ativo ? 'desativar' : 'ativar';
    if (!window.confirm(`Deseja ${acao} o usuário ${u.nome}?`)) return;

    setNotice('');
    setError('');
    try {
      await adminAPI.alterarStatus(u.id, !u.ativo);
      setNotice(`Usuário ${u.ativo ? 'desativado' : 'ativado'} com sucesso.`);
      await carregar();
    } catch (err: any) {
      setError(erroDaApi(err, 'Erro ao alterar status do usuário'));
    }
  };

  const regioes = form.cidade ? cidades[form.cidade] || [] : [];
  const editando = modal?.mode === 'edit';

  return (
    <section className="dash-card users-card">
      <div className="card-head">
        <h2>Usuários</h2>
        <button type="button" className="users-btn users-btn-primary" onClick={abrirCriar}>
          + Novo usuário
        </button>
      </div>

      {notice && <div className="users-alert users-alert-ok">{notice}</div>}
      {error && <div className="users-alert users-alert-error">{error}</div>}

      {loading ? (
        <p className="users-empty">Carregando usuários...</p>
      ) : usuarios.length === 0 && !error ? (
        <p className="users-empty">Nenhum usuário cadastrado.</p>
      ) : (
        <div className="users-table-wrap">
          <table className="users-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>E-mail</th>
                <th>Perfil</th>
                <th>Status</th>
                <th>Criado em</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {usuarios.map((u) => (
                <tr key={u.id}>
                  <td>{u.nome}</td>
                  <td>{u.email}</td>
                  <td>{u.perfil === 'ADMIN' ? 'Administrador' : 'Usuário'}</td>
                  <td>
                    <span className={u.ativo ? 'tag-ok' : 'users-tag-off'}>{u.ativo ? '● Ativo' : '● Inativo'}</span>
                  </td>
                  <td>{formatarData(u.criado_em)}</td>
                  <td className="users-actions">
                    <button type="button" className="users-btn" onClick={() => abrirEditar(u)}>
                      Editar
                    </button>
                    <button
                      type="button"
                      className="users-btn"
                      onClick={() => alternarStatus(u)}
                      disabled={u.id === meuId && u.ativo}
                      title={u.id === meuId && u.ativo ? 'Você não pode desativar a sua própria conta' : undefined}
                    >
                      {u.ativo ? 'Desativar' : 'Ativar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <div className="users-overlay" onClick={fecharModal}>
          <form className="users-modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editando ? 'Editar usuário' : 'Novo usuário'}</h2>
            {!editando && <p className="users-hint">O novo usuário será criado com o perfil de usuário comum.</p>}

            {formError && <div className="users-alert users-alert-error">{formError}</div>}

            <label>
              Nome
              <input name="nome" value={form.nome} onChange={handleChange} maxLength={120} required />
            </label>
            <label>
              E-mail
              <input name="email" type="email" value={form.email} onChange={handleChange} required />
            </label>
            {!editando && (
              <label>
                Senha
                <input
                  name="password"
                  type="password"
                  value={form.password}
                  onChange={handleChange}
                  minLength={6}
                  placeholder="Mínimo de 6 caracteres"
                  required
                />
              </label>
            )}
            <label>
              Cidade
              <select name="cidade" value={form.cidade} onChange={handleChange} required>
                <option value="" disabled>Selecione a cidade</option>
                {Object.keys(cidades).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Região
              <select name="regiao" value={form.regiao} onChange={handleChange} disabled={!form.cidade} required>
                <option value="" disabled>Selecione a região</option>
                {regioes.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>

            <div className="users-modal-actions">
              <button type="button" className="users-btn" onClick={fecharModal} disabled={saving}>
                Cancelar
              </button>
              <button type="submit" className="users-btn users-btn-primary" disabled={saving}>
                {saving ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
