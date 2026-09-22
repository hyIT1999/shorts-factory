import { DatePipe } from '@angular/common';
import { Component, inject, signal, type OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ProjectSummary } from '../../models/api';
import { ProjectService } from '../../services/project.service';
import { apiErrorMessage } from '../../services/api-error';

@Component({
  selector: 'app-projects',
  imports: [RouterLink, DatePipe],
  templateUrl: './projects.html',
  styleUrl: './projects.scss',
})
export class ProjectsPage implements OnInit {
  private readonly projectService = inject(ProjectService);

  protected readonly projects = signal<ProjectSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.projects.set(await this.projectService.getProjects());
      this.error.set(null);
    } catch (err) {
      this.error.set(apiErrorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async remove(project: ProjectSummary): Promise<void> {
    if (!confirm(`Delete "${project.title}"? This removes its videos, scenes and jobs.`)) {
      return;
    }
    try {
      const result = await this.projectService.deleteProject(project.id);
      await this.load();
      if (!result.filesRemoved) {
        this.error.set('Project deleted, but some of its files could not be removed; run "npm run data:sweep" on the server.');
      }
    } catch (err) {
      // 409 PROJECT_ACTIVE while a pipeline runs: abort it on the project page first.
      this.error.set(apiErrorMessage(err));
    }
  }
}
