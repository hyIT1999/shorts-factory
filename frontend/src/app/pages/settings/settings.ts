import { Component, inject, signal, type OnInit } from '@angular/core';
import type { ChannelDna } from '../../models/api';
import { getApiToken, setApiToken } from '../../services/api-token';
import { SettingsService } from '../../services/settings.service';
import { apiErrorMessage } from '../../services/api-error';

interface SettingField {
  readonly key: keyof ChannelDna;
  readonly label: string;
  readonly placeholder: string;
}

@Component({
  selector: 'app-settings',
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class SettingsPage implements OnInit {
  private readonly settings = inject(SettingsService);

  protected readonly fields: readonly SettingField[] = [
    { key: 'niche', label: 'Niche', placeholder: 'e.g. Science' },
    { key: 'targetAudience', label: 'Target audience', placeholder: 'e.g. 18-30' },
    { key: 'language', label: 'Language', placeholder: 'e.g. vi' },
    { key: 'tone', label: 'Tone', placeholder: 'e.g. Curious / mysterious' },
    { key: 'averageDuration', label: 'Average duration (seconds)', placeholder: 'e.g. 40-55' },
    { key: 'hookStyle', label: 'Hook style', placeholder: 'e.g. Question' },
    { key: 'ctaStyle', label: 'CTA style', placeholder: 'e.g. Short' },
    { key: 'visualStyle', label: 'Visual style', placeholder: 'e.g. Dark documentary' },
    { key: 'subtitleStyle', label: 'Subtitle style', placeholder: 'e.g. White with yellow emphasis' },
    { key: 'voice', label: 'Voice', placeholder: 'e.g. Male / Deep' },
    { key: 'musicStyle', label: 'Music style', placeholder: 'e.g. Cinematic' },
  ];

  protected readonly dna = signal<ChannelDna | null>(null);
  protected readonly saving = signal(false);
  protected readonly message = signal<{ kind: 'ok' | 'error'; text: string } | null>(null);

  /** Browser-side only: the token the server expects when it runs with API_TOKEN. */
  protected readonly apiToken = signal(getApiToken());
  protected readonly tokenMessage = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      this.dna.set(await this.settings.getChannelDna());
    } catch (err) {
      this.message.set({ kind: 'error', text: apiErrorMessage(err) });
    }
  }

  protected onInput(key: keyof ChannelDna, event: Event): void {
    const current = this.dna();
    if (current) {
      this.dna.set({ ...current, [key]: (event.target as HTMLInputElement).value });
      this.message.set(null);
    }
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const current = this.dna();
    if (!current) {
      return;
    }
    this.saving.set(true);
    try {
      this.dna.set(await this.settings.saveChannelDna(current));
      this.message.set({ kind: 'ok', text: 'Channel DNA saved.' });
    } catch (err) {
      this.message.set({ kind: 'error', text: apiErrorMessage(err) });
    } finally {
      this.saving.set(false);
    }
  }

  protected onTokenInput(event: Event): void {
    this.apiToken.set((event.target as HTMLInputElement).value);
    this.tokenMessage.set(null);
  }

  /** Stores the token in this browser only; it is sent as a Bearer header with every API request. */
  protected saveToken(event: Event): void {
    event.preventDefault();
    setApiToken(this.apiToken());
    this.apiToken.set(getApiToken());
    this.tokenMessage.set(this.apiToken() ? 'API token stored in this browser.' : 'API token cleared.');
  }
}
