import React, { useEffect, useState } from 'react';
import Login from './components/Login';
import ForgotPassword from './components/ForgotPassword';
import Register from './components/Register';
import Dashboard, { UserRole } from './components/Dashboard';
import { authAPI, limparSessao, SESSAO_ENCERRADA_EVENTO } from './api';

type PageType = 'login' | 'forgot-password' | 'register' | 'dashboard';

const papelDoPerfil = (perfil?: string): UserRole => (perfil === 'ADMIN' ? 'admin' : 'user');

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<PageType>('login');
  const [session, setSession] = useState<{ role: UserRole; name: string }>({ role: 'user', name: '' });

  // Com um token guardado (F5, nova aba) nenhuma tela é mostrada antes de o backend confirmar a sessão
  const [validandoSessao, setValidandoSessao] = useState(() => !!localStorage.getItem('authToken'));
  const [aviso, setAviso] = useState('');

  useEffect(() => {
    if (!localStorage.getItem('authToken')) return;

    let cancelado = false;
    authAPI
      .me()
      .then(({ data }) => {
        if (cancelado) return;
        // Perfil e dados vêm do backend, não do que está no armazenamento
        localStorage.setItem('user', JSON.stringify(data.user));
        setSession({ role: papelDoPerfil(data.user.perfil), name: data.user.nome });
        setCurrentPage('dashboard');
      })
      .catch(() => {
        // 401: o interceptor já limpou a sessão e avisou o app. Falha de rede: vai para o Login
        // sem apagar o token, para a próxima tentativa (F5) validar de novo
      })
      .finally(() => {
        if (!cancelado) setValidandoSessao(false);
      });

    return () => {
      cancelado = true;
    };
  }, []);

  // 401 em qualquer rota autenticada (tratado no interceptor do Axios): volta para o Login
  useEffect(() => {
    const aoEncerrarSessao = () => {
      setSession({ role: 'user', name: '' });
      setAviso('Sua sessão expirou ou foi encerrada. Entre novamente.');
      setCurrentPage('login');
    };
    window.addEventListener(SESSAO_ENCERRADA_EVENTO, aoEncerrarSessao);
    return () => window.removeEventListener(SESSAO_ENCERRADA_EVENTO, aoEncerrarSessao);
  }, []);

  if (validandoSessao) {
    return <div className="session-check" role="status">Verificando sessão…</div>;
  }

  if (currentPage === 'dashboard') {
    return (
      <Dashboard
        role={session.role}
        userName={session.name}
        onLogout={() => {
          limparSessao();
          setAviso('');
          setSession({ role: 'user', name: '' });
          setCurrentPage('login');
        }}
      />
    );
  }

  if (currentPage === 'forgot-password') {
    return <ForgotPassword onBack={() => setCurrentPage('login')} />;
  }

  if (currentPage === 'register') {
    return (
      <Register
        onBackToLogin={() => setCurrentPage('login')}
        onRegistered={(role, name) => {
          setAviso('');
          setSession({ role, name });
          setCurrentPage('dashboard');
        }}
      />
    );
  }

  return (
    <Login
      notice={aviso}
      onForgotPassword={() => setCurrentPage('forgot-password')}
      onCreateAccount={() => setCurrentPage('register')}
      onLogin={(role, name) => {
        setAviso('');
        setSession({ role, name });
        setCurrentPage('dashboard');
      }}
    />
  );
};

export default App;