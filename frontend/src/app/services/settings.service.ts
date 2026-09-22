import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ChannelDna } from '../models/api';

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly http = inject(HttpClient);
  private readonly url = '/api/settings/channel-dna';

  getChannelDna(): Promise<ChannelDna> {
    return firstValueFrom(this.http.get<ChannelDna>(this.url));
  }

  saveChannelDna(dna: ChannelDna): Promise<ChannelDna> {
    return firstValueFrom(this.http.put<ChannelDna>(this.url, dna));
  }
}
