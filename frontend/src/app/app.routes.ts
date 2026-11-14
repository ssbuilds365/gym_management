
import { Routes } from '@angular/router';

export const routes: Routes = [

  {
    path: 'register',
    loadComponent: () => import('./pages/auth/register/register').then(module => module.Register)
  },

  {
    path: 'login',
    loadComponent: () => import('./pages/auth/login/login').then(module => module.Login)
  },

  {
    path: 'forgot-password',
    loadComponent: () => import('./pages/auth/forgot-password/forgot-password')
      .then(module => module.ForgotPassword)
  },

  {
    path: 'reset-password',
    loadComponent: () => import('./pages/auth/reset-password/reset-password')
      .then(module => module.ResetPassword)
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
