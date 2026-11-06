
import { Routes } from '@angular/router';

import { Register } from './pages/auth/register/register';
import { Login } from './pages/auth/login/login';
import { ForgotPassword } from './pages/auth/forgot-password/forgot-password';
import { ResetPassword } from './pages/auth/reset-password/reset-password';

export const routes: Routes = [

  {
    path: 'register',
    component: Register
  },

  {
    path: 'login',
    component: Login
  },

  {
    path: 'forgot-password',
    component: ForgotPassword
  },

  {
    path: 'reset-password',
    component: ResetPassword
  },

  // Dashboard is rendered inside the App shell
  {
    path: 'dashboard',
    pathMatch: 'full',
    children: []
  },

  // Members is rendered inside the App shell
  {
    path: 'members',
    pathMatch: 'full',
    children: []
  },

  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'dashboard'
  },

  {
    path: '**',
    redirectTo: 'dashboard'
  }

];
