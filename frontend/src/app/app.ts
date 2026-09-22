import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

interface NavItem {
  readonly label: string;
  readonly path: string;
  readonly exact: boolean;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly nav: readonly NavItem[] = [
    { label: 'Home', path: '/', exact: true },
    { label: 'Create', path: '/create', exact: true },
    { label: 'Projects', path: '/projects', exact: false },
    { label: 'Settings', path: '/settings', exact: true },
  ];
}
