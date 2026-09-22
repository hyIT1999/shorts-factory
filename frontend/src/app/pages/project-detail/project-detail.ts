import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, input, signal, type OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ACTIVE_STATUSES,
  PIPELINE,
  RERUN_STAGES,
  type JobStatus,
  type JobSummary,
  type JobType,
  type ProjectDetail,
  type RerunStage,
} from '../../models/api';
import { JobService } from '../../services/job.service';
import { ProjectService } from '../../services/project.service';
import { VideoService } from '../../services/video.service';
import { apiErrorMessage } from '../../services/api-error';

const POLL_INTERVAL_MS = 1500;

interface PipelineStage {
  type: JobType;
  status: JobStatus | 'NOT_STARTED';
  icon: string;
}

const STAGE_ICONS: Record<PipelineStage['status'], string> = {
  NOT_STARTED: '○',
  PENDING: '○',
  RUNNING: '⏳',
  COMPLETED: '✓',
  FAILED: '✕',
  CANCELLED: '–',
};

@Component({
  selector: 'app-project-detail',
  imports: [RouterLink, DatePipe, DecimalPipe],
  templateUrl: './project-detail.html',
  styleUrl: './project-detail.scss',
})
export class ProjectDetailPage implements OnInit {
  private readonly projectService = inject(ProjectService);
  private readonly videoService = inject(VideoService);
  private readonly jobService = inject(JobService);

  /** Bound from the `:id` route parameter. */
  readonly id = input.required<string>();

  protected readonly rerunStages = RERUN_STAGES;
  protected readonly project = signal<ProjectDetail | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly starting = signal(false);
  /** A re-run or abort request is in flight. */
  protected readonly busy = signal(false);

  protected readonly latestVideo = computed(() => this.project()?.videos[0] ?? null);

  protected readonly isActive = computed(() => {
    const status = this.project()?.status;
    return status !== undefined && ACTIVE_STATUSES.includes(status);
  });

  /** Jobs belonging to the latest video, in creation order. */
  protected readonly latestJobs = computed<JobSummary[]>(() => {
    const video = this.latestVideo();
    const jobs = this.project()?.jobs ?? [];
    return video ? jobs.filter((job) => job.videoId === video.id) : [];
  });

  /** The job that is running or waiting right now (the one an abort would cancel). */
  protected readonly activeJob = computed<JobSummary | null>(
    () => this.latestJobs().find((job) => job.status === 'RUNNING' || job.status === 'PENDING') ?? null,
  );

  protected readonly stages = computed<PipelineStage[]>(() => {
    const jobs = this.latestJobs();
    return PIPELINE.map((type) => {
      const job = jobs.filter((j) => j.type === type).at(-1);
      const status = job?.status ?? 'NOT_STARTED';
      return { type, status, icon: STAGE_ICONS[status] };
    });
  });

  /** The rendered MP4 of the latest video, once RENDER has produced one. */
  protected readonly outputUrl = computed(() => {
    const video = this.latestVideo();
    return video?.outputPath ? this.videoService.outputUrl(video.id) : null;
  });

  protected readonly downloadUrl = computed(() => {
    const video = this.latestVideo();
    return video?.outputPath ? this.videoService.outputUrl(video.id, true) : null;
  });

  /** Re-runs need a finished (or failed) pipeline and a video to work on. */
  protected readonly canRerun = computed(() => !this.isActive() && this.latestVideo() !== null);

  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      clearTimeout(this.pollTimer);
    });
  }

  ngOnInit(): void {
    void this.refresh();
  }

  protected async generate(): Promise<void> {
    this.starting.set(true);
    this.actionError.set(null);
    try {
      await this.projectService.generateProject(this.id());
    } catch (err) {
      // 409 GENERATION_ALREADY_ACTIVE and other API errors carry a readable message.
      this.actionError.set(apiErrorMessage(err));
    } finally {
      this.starting.set(false);
    }
    await this.refresh();
  }

  /** Re-runs one stage of the latest video (no script/scene AI call). */
  protected async rerun(stage: RerunStage): Promise<void> {
    const video = this.latestVideo();
    if (!video) {
      return;
    }
    await this.perform(() => this.videoService.rerun(video.id, stage));
  }

  /** Cancels the job that is running or waiting; the pipeline can then be re-run. */
  protected async abort(): Promise<void> {
    const job = this.activeJob();
    if (!job || !confirm(`Abort the ${job.type} job? The pipeline stops and can be re-run.`)) {
      return;
    }
    await this.perform(() => this.jobService.abortJob(job.id));
  }

  private async perform(action: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    this.actionError.set(null);
    try {
      await action();
    } catch (err) {
      this.actionError.set(apiErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
    await this.refresh();
  }

  /** Loads the project and keeps polling while its pipeline is active. */
  private async refresh(): Promise<void> {
    clearTimeout(this.pollTimer);
    try {
      this.project.set(await this.projectService.getProject(this.id()));
      this.loadError.set(null);
    } catch (err) {
      this.loadError.set(apiErrorMessage(err));
    }
    if (!this.destroyed && this.isActive()) {
      this.pollTimer = setTimeout(() => void this.refresh(), POLL_INTERVAL_MS);
    }
  }
}
