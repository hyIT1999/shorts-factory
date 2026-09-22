import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API_TOKEN_STORAGE_KEY, apiTokenInterceptor, getApiToken, setApiToken, withApiToken } from './api-token';

describe('api token', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiTokenInterceptor])), provideHttpClientTesting()],
    });
  });

  it('stores, trims and clears the token', () => {
    expect(getApiToken()).toBe('');
    setApiToken('  secret-token-value  ');
    expect(getApiToken()).toBe('secret-token-value');
    expect(localStorage.getItem(API_TOKEN_STORAGE_KEY)).toBe('secret-token-value');
    setApiToken('   ');
    expect(getApiToken()).toBe('');
  });

  it('adds the token to /api requests only when one is stored', () => {
    const http = TestBed.inject(HttpClient);
    const backend = TestBed.inject(HttpTestingController);

    http.get('/api/projects').subscribe();
    expect(backend.expectOne('/api/projects').request.headers.has('Authorization')).toBe(false);

    setApiToken('secret-token-value');
    http.get('/api/projects').subscribe();
    expect(backend.expectOne('/api/projects').request.headers.get('Authorization')).toBe('Bearer secret-token-value');

    http.get('/assets/logo.svg').subscribe();
    expect(backend.expectOne('/assets/logo.svg').request.headers.has('Authorization')).toBe(false);
    backend.verify();
  });

  it('appends the token to browser-loaded URLs', () => {
    expect(withApiToken('/api/videos/v1/output')).toBe('/api/videos/v1/output');
    setApiToken('a b');
    expect(withApiToken('/api/videos/v1/output')).toBe('/api/videos/v1/output?token=a%20b');
    expect(withApiToken('/api/videos/v1/output?download=1')).toBe('/api/videos/v1/output?download=1&token=a%20b');
  });
});
