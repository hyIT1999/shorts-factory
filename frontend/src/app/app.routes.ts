import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'Shorts Factory',
    loadComponent: () => import('./pages/home/home').then((m) => m.HomePage),
  },
  {
    path: 'create',
    title: 'Create · Shorts Factory',
    loadComponent: () => import('./pages/create/create').then((m) => m.CreatePage),
  },
  {
    path: 'projects',
    title: 'Projects · Shorts Factory',
    loadComponent: () => import('./pages/projects/projects').then((m) => m.ProjectsPage),
  },
  {
    path: 'projects/:id',
    title: 'Project · Shorts Factory',
    loadComponent: () =>
      import('./pages/project-detail/project-detail').then((m) => m.ProjectDetailPage),
  },
  {
    path: 'settings',
    title: 'Settings · Shorts Factory',
    loadComponent: () => import('./pages/settings/settings').then((m) => m.SettingsPage),
  },
  { path: '**', redirectTo: '' },
];
