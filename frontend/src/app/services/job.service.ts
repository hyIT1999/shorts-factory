import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { JobDetail } from '../models/api';

@Injectable({ providedIn: 'root' })
export class JobService {
  private readonly http = inject(HttpClient);

  getJob(id: string): Promise<JobDetail> {
    return firstValueFrom(this.http.get<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`));
  }

  /** Cancels a pending or running job; its video and project become FAILED and can be re-run. */
  abortJob(id: string): Promise<JobDetail> {
    return firstValueFrom(this.http.post<JobDetail>(`/api/jobs/${encodeURIComponent(id)}/abort`, {}));
  }
}
