/** Types mirroring the Shorts Factory API responses. Dates arrive as ISO strings. */

export type ProjectStatus = 'DRAFT' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
export type VideoStatus = ProjectStatus;
export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type JobType = 'RESEARCH' | 'SCRIPT' | 'SCENES' | 'ASSETS' | 'VOICE' | 'SUBTITLES' | 'RENDER';

export const PIPELINE: readonly JobType[] = [
  'RESEARCH',
  'SCRIPT',
  'SCENES',
  'ASSETS',
  'VOICE',
  'SUBTITLES',
  'RENDER',
];

export interface ProjectSummary {
  id: string;
  title: string;
  topic: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

/** The selected image of a scene: its provider and the credit stock providers require. */
export interface SceneVisual {
  provider: string;
  fallback: boolean;
  credit: string | null;
  creditUrl: string | null;
}

export interface SceneDetail {
  id: string;
  index: number;
  text: string;
  duration: number | null;
  visualPrompt: string | null;
  visualType: string | null;
  startTime: number | null;
  endTime: number | null;
  subtitleEmphasis: string[];
  visual: SceneVisual | null;
}

export interface Source {
  title: string;
  url: string;
}

export interface ResearchResult {
  topic: string;
  summary: string;
  hookFact?: string;
  facts: { claim: string; explanation: string; confidence: 'established' | 'debated'; visualIdea?: string }[];
  curiosityScore?: number;
  visualScore?: number;
  sources: Source[];
}

export interface ScriptResult {
  title: string;
  hook: string;
  narration: string;
  language: string;
  targetDuration: number;
  cta: string;
  sources: Source[];
}

export interface VideoDetail {
  id: string;
  version: number;
  status: VideoStatus;
  title: string | null;
  description: string | null;
  duration: number | null;
  outputPath: string | null;
  createdAt: string;
  updatedAt: string;
  research: ResearchResult | null;
  script: ScriptResult | null;
  scenes: SceneDetail[];
}

export interface JobSummary {
  id: string;
  videoId: string | null;
  type: JobType;
  status: JobStatus;
  attempts: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type JobDetail = Omit<JobSummary, 'videoId'>;

export interface ProjectDetail extends ProjectSummary {
  videos: VideoDetail[];
  jobs: JobSummary[];
}

export interface CreateProjectRequest {
  title: string;
  topic: string;
}

export interface GenerateResponse {
  projectId: string;
  videoId: string;
  jobId: string;
  status: ProjectStatus;
}

export interface DeleteProjectResponse {
  deleted: boolean;
  id: string;
  /** false when some files could not be removed (the server logged it; a storage sweep picks them up). */
  filesRemoved: boolean;
}

/** Stages that can be re-run for the latest video without calling the script/scene AI. */
export type RerunStage = 'ASSETS' | 'VOICE' | 'SUBTITLES' | 'RENDER';
export const RERUN_STAGES: readonly RerunStage[] = ['ASSETS', 'VOICE', 'SUBTITLES', 'RENDER'];

export interface RerunResponse {
  projectId: string;
  videoId: string;
  jobId: string;
  stage: RerunStage;
  status: ProjectStatus;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export const ACTIVE_STATUSES: readonly ProjectStatus[] = ['QUEUED', 'PROCESSING'];

export interface ChannelDna {
  niche: string;
  targetAudience: string;
  language: string;
  tone: string;
  averageDuration: string;
  hookStyle: string;
  ctaStyle: string;
  visualStyle: string;
  subtitleStyle: string;
  voice: string;
  musicStyle: string;
}
