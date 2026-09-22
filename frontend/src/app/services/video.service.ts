import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { RerunResponse, RerunStage } from '../models/api';
import { withApiToken } from './api-token';

@Injectable({ providedIn: 'root' })
export class VideoService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/api/videos';

  /** Re-runs a stage of the latest video; the pipeline continues from there. */
  rerun(videoId: string, stage: RerunStage): Promise<RerunResponse> {
    return firstValueFrom(
      this.http.post<RerunResponse>(`${this.baseUrl}/${encodeURIComponent(videoId)}/rerun`, { stage }),
    );
  }

  /** URL of the rendered MP4 for a <video> element, or for a download link. */
  outputUrl(videoId: string, download = false): string {
    return withApiToken(`${this.baseUrl}/${encodeURIComponent(videoId)}/output${download ? '?download=1' : ''}`);
  }
}
