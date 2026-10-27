import React, { useState } from 'react';
import Login from './components/Login';
import ForgotPassword from './components/ForgotPassword';
import ComingSoon from './components/ComingSoon';

type PageType = 'login' | 'forgot-password' | 'coming-soon';

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<PageType>('login');

  return (
    <div>
      {currentPage === 'login' ? (
        <Login 
          onForgotPassword={() => setCurrentPage('forgot-password')}
          onCreateAccount={() => setCurrentPage('coming-soon')}
        />
      ) : currentPage === 'forgot-password' ? (
        <ForgotPassword onBack={() => setCurrentPage('login')} />
      ) : (
        <ComingSoon onBack={() => setCurrentPage('login')} />
      )}
    </div>
  );
};

export default App;
