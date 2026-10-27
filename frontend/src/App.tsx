import React, { useState } from 'react';
import Login from './components/Login';
import ForgotPassword from './components/ForgotPassword';
import Register from './components/Register';
import Dashboard, { UserRole } from './components/Dashboard';

type PageType = 'login' | 'forgot-password' | 'register' | 'dashboard';

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<PageType>('login');
  const [session, setSession] = useState<{ role: UserRole; name: string }>({ role: 'user', name: '' });

  if (currentPage === 'dashboard') {
    return (
      <Dashboard
        role={session.role}
        userName={session.name}
        onLogout={() => {
          localStorage.removeItem('authToken');
          localStorage.removeItem('user');
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
          setSession({ role, name });
          setCurrentPage('dashboard');
        }}
      />
    );
  }

  return (
    <Login
      onForgotPassword={() => setCurrentPage('forgot-password')}
      onCreateAccount={() => setCurrentPage('register')}
      onLogin={(role, name) => {
        setSession({ role, name });
        setCurrentPage('dashboard');
      }}
    />
  );
};

export default App;