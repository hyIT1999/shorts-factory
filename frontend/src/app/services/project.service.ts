import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  CreateProjectRequest,
  DeleteProjectResponse,
  GenerateResponse,
  ProjectDetail,
  ProjectSummary,
} from '../models/api';

@Injectable({ providedIn: 'root' })
export class ProjectService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/api/projects';

  createProject(input: CreateProjectRequest): Promise<ProjectSummary> {
    return firstValueFrom(this.http.post<ProjectSummary>(this.baseUrl, input));
  }

  getProjects(): Promise<ProjectSummary[]> {
    return firstValueFrom(this.http.get<ProjectSummary[]>(this.baseUrl));
  }

  getProject(id: string): Promise<ProjectDetail> {
    return firstValueFrom(this.http.get<ProjectDetail>(`${this.baseUrl}/${encodeURIComponent(id)}`));
  }

  deleteProject(id: string): Promise<DeleteProjectResponse> {
    return firstValueFrom(
      this.http.delete<DeleteProjectResponse>(`${this.baseUrl}/${encodeURIComponent(id)}`),
    );
  }

  generateProject(id: string): Promise<GenerateResponse> {
    return firstValueFrom(
      this.http.post<GenerateResponse>(`${this.baseUrl}/${encodeURIComponent(id)}/generate`, {}),
    );
  }
}
