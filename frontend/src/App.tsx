import React, { useState } from 'react';
import Login from './components/Login';
import ForgotPassword from './components/ForgotPassword';
import Register from './components/Register';

type PageType = 'login' | 'forgot-password' | 'register';

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<PageType>('login');

  if (currentPage === 'forgot-password') {
    return <ForgotPassword onBack={() => setCurrentPage('login')} />;
  }

  if (currentPage === 'register') {
    return <Register onBackToLogin={() => setCurrentPage('login')} />;
  }

  return (
    <Login
      onForgotPassword={() => setCurrentPage('forgot-password')}
      onCreateAccount={() => setCurrentPage('register')}
    />
  );
};

export default App;