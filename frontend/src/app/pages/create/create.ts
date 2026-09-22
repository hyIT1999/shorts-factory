import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ProjectService } from '../../services/project.service';
import { apiErrorMessage } from '../../services/api-error';

const MAX_TITLE = 200;
const MAX_TOPIC = 500;

@Component({
  selector: 'app-create',
  templateUrl: './create.html',
  styleUrl: './create.scss',
})
export class CreatePage {
  private readonly projects = inject(ProjectService);
  private readonly router = inject(Router);

  protected readonly maxTitle = MAX_TITLE;
  protected readonly maxTopic = MAX_TOPIC;
  protected readonly title = signal('');
  protected readonly topic = signal('');
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected onInput(field: 'title' | 'topic', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this[field].set(value);
    this.error.set(null);
  }

  protected async createShort(event: Event): Promise<void> {
    event.preventDefault();
    const title = this.title().trim();
    const topic = this.topic().trim();
    if (!title || !topic) {
      this.error.set('Title and topic are required.');
      return;
    }

    this.submitting.set(true);
    this.error.set(null);
    try {
      const project = await this.projects.createProject({ title, topic });
      await this.router.navigate(['/projects', project.id]);
    } catch (err) {
      this.error.set(apiErrorMessage(err));
    } finally {
      this.submitting.set(false);
    }
  }
}
