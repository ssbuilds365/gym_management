import { HttpHeaders, HttpRequest, HttpResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { environment } from '../../../environments/environment';
import { sessionCookieInterceptor } from '../../interceptors/session-cookie.interceptor';
import { CameraService } from '../../services/camera';
import { FaceRecognitionService } from '../../services/face-recognition';
import { MemberService } from '../../services/member';
import { AttendanceKiosk } from './attendance-kiosk';

describe('AttendanceKiosk authorization', () => {
  let fixture: ComponentFixture<AttendanceKiosk>;
  let httpTestingController: HttpTestingController;

  beforeEach(async () => {
    sessionStorage.clear();
    localStorage.clear();
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
    localStorage.clear();
  });

  const rejectInitialRenewal = async (): Promise<void> => {
    fixture.detectChanges();
    const request = httpTestingController.expectOne(`${environment.apiUrl}/kiosk/renew`);
    expect(request.request.body).toEqual({});
    expect(request.request.headers.get('X-Kiosk-Request')).toBe('1');
    request.flush({
      success: false,
      code: 'KIOSK_REFRESH_REQUIRED',
      message: 'Persistent kiosk authorization is required.'
    }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();
  };

  const restoreAuthorizedKiosk = async (gym: object): Promise<void> => {
    fixture.detectChanges();
    const renewal = httpTestingController.expectOne(`${environment.apiUrl}/kiosk/renew`);
    expect(renewal.request.body).toEqual({});
    expect(renewal.request.headers.get('X-Kiosk-Request')).toBe('1');
    renewal.flush({ success: true, token: 'restored-kiosk-token', expiresInSeconds: 900 });
    await Promise.resolve();
    const config = httpTestingController.expectOne(`${environment.apiUrl}/kiosk/config`);
    expect(config.request.headers.get('Authorization')).toBe('Bearer restored-kiosk-token');
    config.flush({ success: true, gym });
    await fixture.whenStable();
  };

  it('authorizes through the cookie flow and does not persist access or refresh tokens', async () => {
    fixture.detectChanges();
    const renewal = httpTestingController.expectOne(`${environment.apiUrl}/kiosk/renew`);
    renewal.flush({
      success: false,
      code: 'KIOSK_REFRESH_REQUIRED',
      message: 'Persistent kiosk authorization is required.'
    }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    const component = fixture.componentInstance;
    const cameraOpen = vi.spyOn(TestBed.inject(CameraService), 'open')
      .mockRejectedValue(new Error('Camera access must remain user initiated.'));
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
        faceEnrollmentEnabled: false,
        faceEnrollmentRequiresStaff: true,
        qrAttendanceEnabled: true
      }
    });
    await fixture.whenStable();

    expect(component.authenticating).toBe(false);
    expect(component.authorized).toBe(true);
    expect(component.faceEnrollmentEnabled).toBe(false);
    expect(component.faceEnrollmentRequiresStaff).toBe(true);
    expect(component.kioskSecret).toBe('');
    expect(sessionStorage.getItem('ssfm_kiosk_token')).toBeNull();
    expect(localStorage.getItem('ssfm_kiosk_refresh')).toBeNull();
    expect(fixture.nativeElement.querySelector('.authorization')).toBeNull();
    expect(fixture.nativeElement.querySelector('.kiosk-home')).not.toBeNull();
    expect(component.cameraActive).toBe(false);
    expect(cameraOpen).not.toHaveBeenCalled();
  });

  it('prevents duplicate authorization requests and resets loading on failure', async () => {
    await rejectInitialRenewal();
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

  it('restores a kiosk session from its HttpOnly cookie on a cold start', async () => {
    await restoreAuthorizedKiosk({
      name: 'Test Gym',
      faceAttendanceEnabled: true,
      qrAttendanceEnabled: true
    });

    expect(fixture.componentInstance.authorized).toBe(true);
    expect(fixture.componentInstance.token).toBe('restored-kiosk-token');
    expect(sessionStorage.getItem('ssfm_kiosk_token')).toBeNull();
    expect(fixture.nativeElement.querySelector('.kiosk-home')).not.toBeNull();
  });

  it('allows retrying cookie restoration after a temporary network failure', async () => {
    fixture.detectChanges();
    httpTestingController.expectOne(`${environment.apiUrl}/kiosk/renew`).flush(
      { message: 'Network unavailable' },
      { status: 0, statusText: 'Unknown Error' }
    );
    await fixture.whenStable();
    expect(fixture.componentInstance.sessionRetryAvailable).toBe(true);

    fixture.componentInstance.retryKioskSession();
    const renewal = httpTestingController.expectOne(`${environment.apiUrl}/kiosk/renew`);
    renewal.flush({ success: true, token: 'retried-kiosk-token' });
    await Promise.resolve();
    httpTestingController.expectOne(`${environment.apiUrl}/kiosk/config`).flush({
      success: true,
      gym: { name: 'Test Gym', faceAttendanceEnabled: true, qrAttendanceEnabled: true }
    });
    await fixture.whenStable();

    expect(fixture.componentInstance.authorized).toBe(true);
    expect(fixture.componentInstance.sessionRetryAvailable).toBe(false);
  });

  it('disables face enrollment when the backend reports unavailable while retaining QR attendance', async () => {
    await restoreAuthorizedKiosk({
      name: 'Test Gym',
      faceAttendanceEnabled: false,
      faceEnrollmentEnabled: false,
      qrAttendanceEnabled: true
    });
    fixture.detectChanges();

    const registerButton = fixture.nativeElement.querySelector('.face-register-action') as HTMLButtonElement;
    expect(registerButton.disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain(
      'Face registration is temporarily unavailable. Please contact gym staff.'
    );
    expect(fixture.componentInstance.qrEnabled).toBe(true);
  });

  it('requires an owner session before staff face registration', async () => {
    await restoreAuthorizedKiosk({
      name: 'Test Gym',
      faceAttendanceEnabled: true,
      faceEnrollmentEnabled: false,
      faceEnrollmentRequiresStaff: true,
      qrAttendanceEnabled: true
    });
    fixture.detectChanges();

    expect(fixture.componentInstance.faceEnrollmentEnabled).toBe(false);
    const registerButton = fixture.nativeElement.querySelector('.face-register-action') as HTMLButtonElement;
    expect(registerButton.disabled).toBe(false);
    expect(registerButton.textContent).toContain('Register Member Face');
    fixture.componentInstance.openStaffRegistration();
    const profileRequest = httpTestingController.expectOne(request =>
      request.url === `${environment.apiUrl}/auth/profile`
    );
    profileRequest.flush({
      success: false,
      code: 'SESSION_REQUIRED',
      message: 'Please log in to continue.'
    }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.staffAuthStep).toBe('login');
    expect(fixture.nativeElement.textContent).toContain('Kiosk authorization alone cannot register members.');
    httpTestingController.expectNone(`${environment.apiUrl}/members`);

    const message = (fixture.componentInstance as any).getEnrollmentErrorMessage({
      error: { code: 'DUPLICATE_FACE_DETECTED', message: 'internal detail' },
      status: 409
    });
    expect(message).toBe(
      'This face is already registered with another member. Please contact gym staff.'
    );
    expect(message).not.toContain('internal detail');
  });

  it('uses the existing member search API for names, member IDs, and mobile numbers', async () => {
    await restoreAuthorizedKiosk({
      id: 'business-id',
      name: 'Test Gym',
      faceEnrollmentRequiresStaff: true
    });
    const component = fixture.componentInstance;
    component.staffAuthStep = 'authorized';
    const searchTerms = ['Omkar', 'M-208', '5550100'];

    for (const searchTerm of searchTerms) {
      component.staffSearchTerm = searchTerm;
      const searchPromise = component.searchStaffMembers();
      httpTestingController.expectOne(request =>
        request.url === `${environment.apiUrl}/members` &&
        request.params.get('search') === searchTerm
      ).flush({ success: true, members: [] });
      await searchPromise;
    }

    expect(component.staffSearchError).toBe('');
    expect(component.staffMembers).toEqual([]);
  });

  it('searches tenant-scoped members and displays the returned face status after owner verification', async () => {
    await restoreAuthorizedKiosk({
      id: 'business-id',
      name: 'Test Gym',
      faceAttendanceEnabled: true,
      faceEnrollmentRequiresStaff: true,
      qrAttendanceEnabled: true
    });

    const component = fixture.componentInstance;
    component.openStaffRegistration();
    httpTestingController.expectOne(request =>
      request.url === `${environment.apiUrl}/auth/profile`
    ).flush({
      success: true,
      owner: { role: 'owner', businessId: 'business-id' },
      business: { id: 'business-id' },
      session: { id: 'owner-session' }
    });
    await fixture.whenStable();
    expect(component.staffAuthStep).toBe('authorized');

    component.staffSearchTerm = 'alex';
    const searchPromise = component.searchStaffMembers();
    httpTestingController.expectOne(request =>
      request.url === `${environment.apiUrl}/members` &&
      request.params.get('search') === 'alex'
    ).flush({
      success: true,
      members: [{
        _id: 'member-id',
        legacyMemberId: 'M-104',
        fullName: 'Alex Member',
        phone: '5550100',
        status: 'Active',
        membership: { status: 'Active', endDate: '2030-01-01' }
      }]
    });
    await Promise.resolve();
    httpTestingController.expectOne(
      `${environment.apiUrl}/biometric/credentials/status/member-id`
    ).flush({
      success: true,
      status: 'Registered',
      registeredAt: '2025-01-01T10:00:00.000Z'
    });
    await searchPromise;

    expect(component.staffMembers[0].faceStatus).toBe('Registered');
    expect(component.staffMembers[0].registeredAt).toBe('2025-01-01T10:00:00.000Z');
    fixture.detectChanges();
    const updateButton = fixture.nativeElement.querySelector('.member-face-action.update') as HTMLButtonElement;
    expect(updateButton.textContent).toContain('Update Face');
    expect(fixture.nativeElement.querySelector('.member-face-action:not(.update)')).toBeNull();
    updateButton.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Alex Member');
    expect(fixture.nativeElement.textContent).toContain('M-104');
    expect(fixture.nativeElement.textContent).toContain('Face registration: Registered');
  });

  it('shows Register Face on a not-registered result and selects that exact member', async () => {
    await rejectInitialRenewal();
    const component = fixture.componentInstance;
    component.authorized = true;
    component.faceEnrollmentRequiresStaff = true;
    component.staffRegistrationOpen = true;
    component.staffAuthStep = 'authorized';
    component.staffMembers = [{
      _id: 'member-omkar',
      legacyMemberId: 'M-208',
      fullName: 'Omkar',
      phone: '5550100',
      status: 'Active',
      membership: { status: 'Active', endDate: '2030-01-01' },
      faceStatus: 'NotRegistered'
    }];
    fixture.detectChanges();

    const registerButton = fixture.nativeElement.querySelector('.member-face-action') as HTMLButtonElement;
    expect(registerButton.textContent).toContain('Register Face');
    expect(fixture.nativeElement.querySelector('.member-face-action.update')).toBeNull();
    registerButton.click();
    fixture.detectChanges();

    expect(component.staffSelectedMember?._id).toBe('member-omkar');
    expect(fixture.nativeElement.textContent).toContain('Omkar');
    expect(fixture.nativeElement.textContent).toContain('M-208');
    expect(fixture.nativeElement.textContent).toContain('Face registration: NotRegistered');
    const startCameraButton = fixture.nativeElement.querySelector('.self-registration-actions .primary-action') as HTMLButtonElement;
    expect(startCameraButton.disabled).toBe(true);
    expect(component.staffConsent).toBe(false);
  });

  it('does not offer enrollment for an inactive member', async () => {
    await rejectInitialRenewal();
    const component = fixture.componentInstance;
    component.staffRegistrationOpen = true;
    component.staffAuthStep = 'authorized';
    component.staffMembers = [{
      _id: 'inactive-member',
      fullName: 'Inactive Member',
      phone: '5550100',
      status: 'Inactive',
      faceStatus: 'NotRegistered'
    }];
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.member-face-action')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain(
      'Enrollment unavailable: this member is inactive.'
    );
    component.selectStaffMember(component.staffMembers[0]);
    expect(component.staffSelectedMember).toBeNull();
  });

  it('requires explicit replacement authorization and confirmation for Update Face', async () => {
    const component = fixture.componentInstance;
    component.staffAuthStep = 'authorized';
    component.staffConsent = true;
    component.staffSelectedMember = {
      _id: 'registered-member',
      fullName: 'Registered Member',
      phone: '5550100',
      status: 'Active',
      faceStatus: 'Registered'
    };
    component.enrollmentCameraActive = true;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await component.captureStaffEnrollment();
    expect(component.staffEnrollmentError).toContain('Confirm replacement');
    expect(confirmSpy).not.toHaveBeenCalled();

    component.staffReplaceExisting = true;
    await component.captureStaffEnrollment();
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(confirmSpy).toHaveBeenCalledWith(
      "Replace Registered Member's existing face registration?"
    );
    httpTestingController.expectNone(`${environment.apiUrl}/kiosk/staff/enrollment/face/registered-member`);
    confirmSpy.mockRestore();
  });

  it('sends staff samples to the kiosk route with consent and the kiosk bearer token', () => {
    let response: any;
    TestBed.inject(MemberService).registerFaceFromKiosk(
      'member-id',
      ['sample-one', 'sample-two', 'sample-three'],
      'kiosk-staff-face-consent-v1',
      true,
      'kiosk-token',
      false
    ).subscribe(value => { response = value; });

    const request = httpTestingController.expectOne(
      `${environment.apiUrl}/kiosk/staff/enrollment/face/member-id`
    );
    expect(request.request.headers.get('Authorization')).toBe('Bearer kiosk-token');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toEqual({
      images: ['sample-one', 'sample-two', 'sample-three'],
      consentGranted: true,
      consentTextVersion: 'kiosk-staff-face-consent-v1',
      replaceExisting: false
    });
    request.flush({ success: true, status: 'Registered' });
    expect(response.status).toBe('Registered');
  });

  it('releases the registration camera when the staff flow closes', async () => {
    await rejectInitialRenewal();
    const component = fixture.componentInstance;
    const camera = TestBed.inject(CameraService);
    const cameraOpen = vi.spyOn(camera, 'open').mockResolvedValue({
      getTracks: () => []
    } as unknown as MediaStream);
    const cameraStop = vi.spyOn(camera, 'stop');
    component.authorized = true;
    component.faceEnrollmentRequiresStaff = true;
    component.staffRegistrationOpen = true;
    component.staffAuthStep = 'authorized';
    component.staffMembers = [{
      _id: 'member-id',
      legacyMemberId: 'M-104',
      fullName: 'Alex Member',
      phone: '5550100',
      status: 'Active',
      faceStatus: 'NotRegistered'
    }];
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.member-face-action') as HTMLButtonElement).click();
    fixture.detectChanges();
    component.staffConsent = true;

    await component.startStaffEnrollmentCamera();
    expect(cameraOpen).toHaveBeenCalledOnce();
    expect(component.enrollmentCameraActive).toBe(true);

    component.closeStaffRegistration();
    expect(cameraStop).toHaveBeenCalled();
    expect(component.enrollmentCameraActive).toBe(false);
    expect(component.staffRegistrationOpen).toBe(false);
  });

  it('updates the selected search result only after the backend confirms enrollment', async () => {
    await rejectInitialRenewal();
    const component = fixture.componentInstance;
    const member = {
      _id: 'member-omkar',
      legacyMemberId: 'M-208',
      fullName: 'Omkar',
      phone: '5550100',
      status: 'Active',
      membership: { status: 'Active', endDate: '2030-01-01' },
      faceStatus: 'NotRegistered'
    };
    component.authorized = true;
    component.token = 'kiosk-access-token';
    component.faceEnrollmentRequiresStaff = true;
    component.staffRegistrationOpen = true;
    component.staffAuthStep = 'authorized';
    component.staffMembers = [member];
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.member-face-action') as HTMLButtonElement).click();
    fixture.detectChanges();
    component.staffConsent = true;
    fixture.detectChanges();

    const camera = TestBed.inject(CameraService);
    vi.spyOn(camera, 'open').mockResolvedValue({ getTracks: () => [] } as unknown as MediaStream);
    await component.startStaffEnrollmentCamera();

    const faceRecognition = TestBed.inject(FaceRecognitionService);
    vi.spyOn(faceRecognition, 'load').mockResolvedValue();
    vi.spyOn(faceRecognition, 'detectSingleFace').mockResolvedValue({
      x: 10, y: 10, width: 100, height: 100
    });
    vi.spyOn(faceRecognition, 'isStable').mockReturnValue(true);
    vi.spyOn(faceRecognition, 'captureImage').mockReturnValue('data:image/jpeg;base64,c2FtcGxl');
    vi.spyOn(faceRecognition, 'validateEnrollmentSamples').mockImplementation(() => undefined);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0);
      return 1;
    });

    const enrollmentPromise = component.captureStaffEnrollment();
    let registrationRequest: any;
    await vi.waitFor(() => {
      const requests = httpTestingController.match(
        `${environment.apiUrl}/kiosk/staff/enrollment/face/member-omkar`
      );
      if (!requests.length) throw new Error('Waiting for staff registration request.');
      expect(requests).toHaveLength(1);
      registrationRequest = requests[0];
    });
    expect(registrationRequest.request.body).toEqual({
      images: Array(3).fill('data:image/jpeg;base64,c2FtcGxl'),
      consentGranted: true,
      consentTextVersion: 'kiosk-staff-face-consent-v1',
      replaceExisting: false
    });
    expect(registrationRequest.request.headers.get('Authorization')).toBe('Bearer kiosk-access-token');

    registrationRequest.flush({
      success: true,
      status: 'Registered',
      registeredAt: '2026-11-25T10:00:00.000Z'
    });
    await enrollmentPromise;
    fixture.changeDetectorRef.detectChanges();

    expect(component.staffEnrollmentSuccess).toBe(true);
    expect(component.staffSelectedMember?.faceStatus).toBe('Registered');
    expect(component.staffMembers[0].faceStatus).toBe('Registered');
    expect(fixture.nativeElement.textContent).toContain('Face Registered Successfully');
    expect(fixture.nativeElement.textContent).toContain('Status: Registered');
  });

  it('locks the kiosk through the server and confirms the locked state only after revocation', async () => {
    await rejectInitialRenewal();
    const component = fixture.componentInstance;
    component.authorized = true;
    component.token = 'in-memory-access-token';
    component.logoutKiosk();

    const request = httpTestingController.expectOne(`${environment.apiUrl}/kiosk/lock`);
    expect(request.request.body).toEqual({});
    expect(request.request.headers.get('Authorization')).toBe('Bearer in-memory-access-token');
    expect(request.request.headers.get('X-Kiosk-Request')).toBe('1');
    expect(component.authorized).toBe(true);
    request.flush({ success: true, message: 'Kiosk locked.' });

    expect(component.authorized).toBe(false);
    expect(component.kioskLocked).toBe(true);
    expect(component.token).toBe('');
  });

  it('resumes kiosk scanning after the staff registration flow closes when scanning was active', async () => {
    await rejectInitialRenewal();
    const component = fixture.componentInstance;
    component.authorized = true;
    component.faceEnabled = true;
    component.staffRegistrationOpen = true;
    (component as any).resumeKioskScanAfterRegistration = true;
    (component as any).scanningRequested = true;
    const resumeScan = vi.spyOn(component as any, 'startKioskCamera').mockResolvedValue(undefined);

    component.closeStaffRegistration();

    expect(resumeScan).toHaveBeenCalledOnce();
    expect(component.staffRegistrationOpen).toBe(false);
  });

  it('explains invalid model descriptor responses without exposing internal details', async () => {
    await rejectInitialRenewal();
    const message = (fixture.componentInstance as any).getEnrollmentErrorMessage({
      error: { code: 'INVALID_FACE_DESCRIPTOR', message: 'internal detail' },
      status: 503
    });

    expect(message).toBe('Face template generation failed. Please retry or contact gym staff.');
    expect(message).not.toContain('internal detail');
  });

  it('shows the allowlisted backend descriptor validation message', async () => {
    await rejectInitialRenewal();
    const message = (fixture.componentInstance as any).getEnrollmentErrorMessage({
      error: {
        code: 'INVALID_FACE_DESCRIPTOR',
        message: 'A valid 128-value face template is required.'
      },
      status: 400
    });

    expect(message).toBe('A valid 128-value face template is required.');
  });

  it('clears legacy local tokens and asks for cookie-backed reauthorization', async () => {
    sessionStorage.setItem('ssfm_kiosk_token', 'expired-token');
    localStorage.setItem('ssfm_kiosk_refresh', 'legacy-refresh-token');
    fixture.detectChanges();

    const request = httpTestingController.expectOne(`${environment.apiUrl}/kiosk/renew`);
    expect(request.request.body).toEqual({});
    request.flush({
      success: false,
      code: 'KIOSK_REFRESH_REQUIRED',
      message: 'Persistent kiosk authorization is required.'
    }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    expect(fixture.componentInstance.authorized).toBe(false);
    expect(fixture.componentInstance.authError).toBe('');
    expect(sessionStorage.getItem('ssfm_kiosk_token')).toBeNull();
    expect(localStorage.getItem('ssfm_kiosk_refresh')).toBeNull();
    expect(fixture.nativeElement.querySelector('.authorization')).not.toBeNull();
  });

  it('preserves kiosk bearer headers without changing dashboard cookie authentication', async () => {
    await rejectInitialRenewal();
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
