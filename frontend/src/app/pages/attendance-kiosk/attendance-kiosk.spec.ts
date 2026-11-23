import { HttpHeaders, HttpRequest, HttpResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { environment } from '../../../environments/environment';
import { sessionCookieInterceptor } from '../../interceptors/session-cookie.interceptor';
import { AttendanceKiosk } from './attendance-kiosk';

describe('AttendanceKiosk authorization', () => {
  let fixture: ComponentFixture<AttendanceKiosk>;
  let httpTestingController: HttpTestingController;

  beforeEach(async () => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({
      imports: [AttendanceKiosk],
      providers: [
        provideHttpClient(withInterceptors([sessionCookieInterceptor])),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => null } } }
        }
      ]
    }).compileComponents();

    httpTestingController = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AttendanceKiosk);
  });

  afterEach(() => {
    httpTestingController.verify();
    sessionStorage.clear();
  });

  it('switches to the kiosk after success, stores the token, and does not request camera access', async () => {
    fixture.detectChanges();
    const component = fixture.componentInstance;
    component.credentialId = 'kiosk_test';
    component.kioskSecret = 'one-time-secret';
    component.authenticate();
    fixture.detectChanges();

    const request = httpTestingController.expectOne(`${environment.apiUrl}/kiosk/auth`);
    expect(request.request.body).toEqual({
      credentialId: 'kiosk_test',
      kioskSecret: 'one-time-secret'
    });
    expect(component.authenticating).toBe(true);

    request.flush({
      success: true,
      token: 'short-lived-token',
      expiresInSeconds: 900,
      gym: {
        name: 'Test Gym',
        faceAttendanceEnabled: true,
        faceEnrollmentEnabled: true,
        qrAttendanceEnabled: true
      }
    });
    await fixture.whenStable();

    expect(component.authenticating).toBe(false);
    expect(component.authorized).toBe(true);
    expect(component.faceEnrollmentEnabled).toBe(true);
    expect(component.kioskSecret).toBe('');
    expect(sessionStorage.getItem('ssfm_kiosk_token')).toBe('short-lived-token');
    expect(fixture.nativeElement.querySelector('.authorization')).toBeNull();
    expect(fixture.nativeElement.querySelector('.kiosk-home')).not.toBeNull();
    expect(component.cameraActive).toBe(false);
  });

  it('prevents duplicate authorization requests and resets loading on failure', async () => {
    fixture.detectChanges();
    const component = fixture.componentInstance;
    component.credentialId = 'kiosk_test';
    component.kioskSecret = 'invalid-secret';
    component.authenticate();
    component.authenticate();

    const requests = httpTestingController.match(`${environment.apiUrl}/kiosk/auth`);
    expect(requests).toHaveLength(1);
    requests[0].flush({
      success: false,
      code: 'KIOSK_AUTH_INVALID',
      message: 'Invalid kiosk credentials.'
    }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    expect(component.authenticating).toBe(false);
    expect(component.authError).toBe('Invalid kiosk credentials.');
    expect(fixture.nativeElement.textContent).toContain('Invalid kiosk credentials.');
  });

  it('sends a stored kiosk token when validating an existing session', async () => {
    sessionStorage.setItem('ssfm_kiosk_token', 'stored-token');
    fixture.detectChanges();

    const request = httpTestingController.expectOne(`${environment.apiUrl}/kiosk/config`);
    expect(request.request.headers.get('Authorization')).toBe('Bearer stored-token');
    request.flush({
      success: true,
      gym: { name: 'Test Gym', faceAttendanceEnabled: true, qrAttendanceEnabled: true }
    });
    await fixture.whenStable();

    expect(fixture.componentInstance.authorized).toBe(true);
    expect(fixture.nativeElement.querySelector('.kiosk-home')).not.toBeNull();
  });

  it('disables face enrollment when the backend reports unavailable while retaining QR attendance', async () => {
    sessionStorage.setItem('ssfm_kiosk_token', 'stored-token');
    fixture.detectChanges();

    const request = httpTestingController.expectOne(`${environment.apiUrl}/kiosk/config`);
    request.flush({
      success: true,
      gym: {
        name: 'Test Gym',
        faceAttendanceEnabled: false,
        faceEnrollmentEnabled: false,
        qrAttendanceEnabled: true
      }
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const registerButton = fixture.nativeElement.querySelector('.face-register-action') as HTMLButtonElement;
    expect(registerButton.disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain(
      'Face registration is temporarily unavailable. Please contact gym staff.'
    );
    expect(fixture.componentInstance.qrEnabled).toBe(true);
  });

  it('requires staff to enroll kiosk members and maps duplicate responses safely', async () => {
    sessionStorage.setItem('ssfm_kiosk_token', 'stored-token');
    fixture.detectChanges();

    const request = httpTestingController.expectOne(`${environment.apiUrl}/kiosk/config`);
    request.flush({
      success: true,
      gym: {
        name: 'Test Gym',
        faceAttendanceEnabled: true,
        faceEnrollmentEnabled: false,
        faceEnrollmentRequiresStaff: true,
        qrAttendanceEnabled: true
      }
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.faceEnrollmentEnabled).toBe(false);
    expect(fixture.nativeElement.textContent).toContain(
      'Face registration must be completed by gym staff after verifying the member.'
    );
    const message = (fixture.componentInstance as any).getEnrollmentErrorMessage({
      error: { code: 'DUPLICATE_FACE_DETECTED', message: 'internal detail' },
      status: 409
    });
    expect(message).toBe(
      'This face is already registered with another member. Please contact gym staff.'
    );
    expect(message).not.toContain('internal detail');
  });

  it('clears an expired stored token and asks for reauthorization', async () => {
    sessionStorage.setItem('ssfm_kiosk_token', 'expired-token');
    fixture.detectChanges();

    const request = httpTestingController.expectOne(`${environment.apiUrl}/kiosk/config`);
    expect(request.request.headers.get('Authorization')).toBe('Bearer expired-token');
    request.flush({
      success: false,
      code: 'KIOSK_TOKEN_INVALID',
      message: 'Kiosk authorization is invalid or expired.'
    }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    expect(fixture.componentInstance.authorized).toBe(false);
    expect(fixture.componentInstance.authError).toContain('session expired');
    expect(sessionStorage.getItem('ssfm_kiosk_token')).toBeNull();
    expect(fixture.nativeElement.querySelector('.authorization')).not.toBeNull();
  });

  it('preserves kiosk bearer headers without changing dashboard cookie authentication', () => {
    const kioskRequest = new HttpRequest(
      'GET',
      `${environment.apiUrl}/kiosk/config`,
      null,
      { headers: new HttpHeaders({ Authorization: 'Bearer kiosk-token' }) }
    );
    let forwardedKioskRequest: HttpRequest<unknown> | undefined;
    sessionCookieInterceptor(kioskRequest, request => {
      forwardedKioskRequest = request;
      return of(new HttpResponse());
    }).subscribe();
    expect(forwardedKioskRequest?.headers.get('Authorization')).toBe('Bearer kiosk-token');

    const dashboardRequest = new HttpRequest(
      'GET',
      `${environment.apiUrl}/dashboard/stats`,
      null,
      { headers: new HttpHeaders({ Authorization: 'Bearer dashboard-token' }) }
    );
    let forwardedDashboardRequest: HttpRequest<unknown> | undefined;
    sessionCookieInterceptor(dashboardRequest, request => {
      forwardedDashboardRequest = request;
      return of(new HttpResponse());
    }).subscribe();
    expect(forwardedDashboardRequest?.headers.has('Authorization')).toBe(false);
  });
});
