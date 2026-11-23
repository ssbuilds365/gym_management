import { HttpHeaders, HttpRequest, HttpResponse } from '@angular/common/http';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { environment } from '../../environments/environment';
import { sessionCookieInterceptor } from '../interceptors/session-cookie.interceptor';
import { AuthService } from './auth';

describe('AuthService', () => {
  let service: AuthService;
  let httpTestingController: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    service = TestBed.inject(AuthService);
    httpTestingController = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTestingController.verify();
    localStorage.clear();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('stores the opaque session reference after login without storing an auth token', () => {
    service.login({ email: 'owner@example.test', password: 'not-a-real-password' }).subscribe();
    const request = httpTestingController.expectOne(`${environment.apiUrl}/auth/login`);
    expect(request.request.method).toBe('POST');
    request.flush({
      success: true,
      session: { id: 'session-reference' },
      owner: { id: 'owner-id', name: 'Owner' },
      business: { id: 'business-id', businessName: 'Gym' }
    });

    expect(service.isLoggedIn()).toBe(true);
    expect(service.getSessionReference()).toBe('session-reference');
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('owner')).toContain('"Owner"');
  });

  it('sends profile requests with cookie credentials and strips any stale bearer header', () => {
    const profileRequest = new HttpRequest(
      'GET',
      `${environment.apiUrl}/auth/profile`,
      null,
      { headers: new HttpHeaders({ Authorization: 'Bearer stale-token' }) }
    );
    let forwarded: HttpRequest<unknown> | undefined;

    sessionCookieInterceptor(profileRequest, request => {
      forwarded = request;
      return of(new HttpResponse());
    }).subscribe();

    expect(forwarded?.withCredentials).toBe(true);
    expect(forwarded?.headers.has('Authorization')).toBe(false);
  });

  it('does not block the public login endpoint and includes cookie credentials', () => {
    const loginRequest = new HttpRequest(
      'POST',
      `${environment.apiUrl}/auth/login`,
      { email: 'owner@example.test', password: 'not-a-real-password' }
    );
    let forwarded: HttpRequest<unknown> | undefined;

    sessionCookieInterceptor(loginRequest, request => {
      forwarded = request;
      return of(new HttpResponse());
    }).subscribe();

    expect(forwarded?.url).toBe(loginRequest.url);
    expect(forwarded?.withCredentials).toBe(true);
    expect(forwarded?.headers.has('Authorization')).toBe(false);
  });
});
