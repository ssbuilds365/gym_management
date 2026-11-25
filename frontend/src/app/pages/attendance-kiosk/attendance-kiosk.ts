import { CommonModule } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom, finalize } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../services/auth';
import { CameraError, CameraService } from '../../services/camera';
import { FaceRecognitionError, FaceRecognitionService } from '../../services/face-recognition';
import { MemberService } from '../../services/member';

type KioskResult = {
  type: 'success' | 'expired' | 'duplicate' | 'not-found' | 'camera' | 'error';
  title: string;
  message: string;
  memberName?: string;
  memberId?: string;
  time?: string;
  expiryDate?: string;
  membershipPlan?: string;
  validUntil?: string;
};

type StaffMember = {
  _id: string;
  legacyMemberId?: string;
  fullName: string;
  phone: string;
  status: string;
  membership?: {
    status?: string;
    endDate?: string;
    planId?: { planName?: string };
  } | null;
  faceStatus?: string;
  registeredAt?: string | null;
};

@Component({
  selector: 'app-attendance-kiosk',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './attendance-kiosk.html',
  styleUrl: './attendance-kiosk.scss'
})
export class AttendanceKiosk implements OnInit, OnDestroy {
  @ViewChild('video', { static: false }) videoRef?: ElementRef<HTMLVideoElement>;
  @ViewChild('enrollmentVideo', { static: false }) enrollmentVideoRef?: ElementRef<HTMLVideoElement>;
  private readonly refreshStorageKey = 'ssfm_kiosk_refresh';

  credentialId = '';
  kioskSecret = '';
  token = '';
  authorized = false;
  authenticating = false;
  authError = '';

  gymName = 'SS Fitness Manager';
  gymLogoUrl = '';
  gymId = '';
  faceEnabled = false;
  qrEnabled = false;
  now = new Date();
  clockTimer: ReturnType<typeof setInterval> | null = null;

  cameraActive = false;
  cameraError = '';
  cameraStatus = 'Camera idle';
  faceEnrollmentEnabled = false;
  faceEnrollmentRequiresStaff = false;
  staffRegistrationOpen = false;
  staffAuthStep: 'checking' | 'login' | 'authorized' | 'denied' | 'unavailable' = 'checking';
  staffEmail = '';
  staffPassword = '';
  staffAuthError = '';
  staffAuthBusy = false;
  staffSearchTerm = '';
  staffMembers: StaffMember[] = [];
  staffSearchError = '';
  staffFaceStatusWarning = '';
  staffSearchLoading = false;
  staffSelectedMember: StaffMember | null = null;
  staffConsent = false;
  staffReplaceExisting = false;
  staffEnrollmentError = '';
  staffEnrollmentLoading = false;
  staffEnrollmentSuccess = false;
  staffEnrollmentStage = '';
  staffRegistrationAt = '';
  enrollmentCameraActive = false;
  scanning = false;
  modelsLoading = false;
  faceStatus = 'Start Face Scan';
  result: KioskResult | null = null;
  accessDenied = false;
  networkOnline = navigator.onLine;

  private modelsLoaded = false;
  private enrollmentOwnsCamera = false;
  private previousScanFaceBox: { x: number; y: number; width: number; height: number } | null = null;
  private wakeLock: any = null;
  private kioskRenewTimer: ReturnType<typeof setInterval> | null = null;
  private continuousScanTimer: ReturnType<typeof setInterval> | null = null;
  private continuousScanInProgress = false;
  private recognitionCooldownUntil = 0;
  private resultTimer: ReturnType<typeof setTimeout> | null = null;
  private staffSearchSequence = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly route: ActivatedRoute,
    private readonly authService: AuthService,
    private readonly memberService: MemberService,
    private readonly cameraService: CameraService,
    private readonly faceRecognition: FaceRecognitionService,
    private readonly changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.accessDenied = Boolean(this.route.snapshot.paramMap.get('section'));
    this.clockTimer = setInterval(() => {
      this.now = new Date();
      this.changeDetector.markForCheck();
    }, 1000);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('online', this.onNetworkStatusChange);
    window.addEventListener('offline', this.onNetworkStatusChange);
    this.token = sessionStorage.getItem('ssfm_kiosk_token') || '';
    if (this.token) {
      this.validateStoredSession();
    } else {
      void this.renewStoredSession();
    }
  }

  ngOnDestroy(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.kioskRenewTimer) clearInterval(this.kioskRenewTimer);
    if (this.continuousScanTimer) clearInterval(this.continuousScanTimer);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('online', this.onNetworkStatusChange);
    window.removeEventListener('offline', this.onNetworkStatusChange);
    void this.releaseWakeLock();
    this.stopEnrollmentCamera();
    this.stopCamera();
  }

  authenticate(): void {
    if (this.authenticating) return;
    this.authenticating = true;
    this.authError = '';
    this.http.post<any>(`${environment.apiUrl}/kiosk/auth`, {
      credentialId: this.credentialId.trim(),
      kioskSecret: this.kioskSecret
    }).pipe(finalize(() => {
      this.authenticating = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: response => {
        if (response?.success !== true || typeof response.token !== 'string' || !response.token) {
          this.authError = response?.message || 'The kiosk authorization response was incomplete.';
          return;
        }
        const gym = response.gym || {};
        try {
          sessionStorage.setItem('ssfm_kiosk_gym', JSON.stringify(gym));
          sessionStorage.setItem('ssfm_kiosk_token', response.token);
          if (typeof response.refreshToken === 'string' && response.refreshToken) {
            localStorage.setItem(this.refreshStorageKey, response.refreshToken);
          }
        } catch {
          this.authError = 'This browser could not save the kiosk session. Check its storage settings and try again.';
          return;
        }
        this.token = response.token;
        this.authorized = true;
        this.applyGymConfig(gym, false);
        this.kioskSecret = '';
        this.changeDetector.markForCheck();
        this.startRenewalTimer();
        void this.requestWakeLock();
      },
      error: error => {
        this.authError = error.error?.message ||
          (error.status === 0
            ? 'Could not reach the authorization server. Check the network and try again.'
            : 'Kiosk authorization failed. Check the credentials and try again.');
      }
    });
  }

  private validateStoredSession(): void {
    this.http.get<any>(`${environment.apiUrl}/kiosk/config`, {
      headers: this.kioskHeaders()
    }).subscribe({
      next: response => {
        this.applyGymConfig(response.gym || {});
        this.authorized = true;
        this.changeDetector.markForCheck();
        this.startRenewalTimer();
        void this.requestWakeLock();
      },
      error: error => {
        this.clearKioskSession();
        this.authError = error.status === 401
          ? 'Kiosk session expired. Enter the kiosk credentials to authorize again.'
          : error.error?.message || 'Unable to verify the kiosk session. Authorize the kiosk again.';
        this.changeDetector.markForCheck();
      }
    });
  }

  private applyGymConfig(gym: any, persist = true): void {
    this.gymName = gym.name || this.gymName;
    this.gymLogoUrl = gym.logoUrl || '';
    this.gymId = String(gym.id || '');
    this.faceEnabled = Boolean(gym.faceAttendanceEnabled);
    this.faceEnrollmentEnabled = Boolean(gym.faceEnrollmentEnabled);
    this.faceEnrollmentRequiresStaff = Boolean(gym.faceEnrollmentRequiresStaff);
    this.qrEnabled = Boolean(gym.qrAttendanceEnabled);
    if (persist) sessionStorage.setItem('ssfm_kiosk_gym', JSON.stringify(gym));
  }

  logoutKiosk(): void {
    this.stopCamera();
    void this.releaseWakeLock();
    if (this.kioskRenewTimer) clearInterval(this.kioskRenewTimer);
    const refreshToken = localStorage.getItem(this.refreshStorageKey) || '';
    if (this.token) {
      this.http.post<any>(`${environment.apiUrl}/kiosk/lock`, { refreshToken }, {
        headers: this.kioskHeaders()
      }).subscribe({ error: () => undefined });
    }
    this.clearKioskSession();
  }

  openStaffRegistration(): void {
    if (!this.authorized || !this.faceEnrollmentRequiresStaff || this.scanning) return;
    this.stopCamera();
    this.staffRegistrationOpen = true;
    this.staffAuthStep = 'checking';
    this.staffEmail = '';
    this.staffPassword = '';
    this.staffAuthError = '';
    this.staffSearchTerm = '';
    this.staffMembers = [];
    this.staffSelectedMember = null;
    this.staffSearchError = '';
    this.staffFaceStatusWarning = '';
    this.staffConsent = false;
    this.staffReplaceExisting = false;
    this.staffEnrollmentError = '';
    this.staffEnrollmentSuccess = false;
    this.staffRegistrationAt = '';
    this.staffSearchLoading = false;
    this.staffSearchSequence += 1;
    void this.verifyStaffSession();
  }

  closeStaffRegistration(): void {
    this.stopEnrollmentCamera();
    this.staffSearchSequence += 1;
    this.staffRegistrationOpen = false;
    this.staffPassword = '';
    this.staffSelectedMember = null;
    this.staffConsent = false;
    this.staffReplaceExisting = false;
  }

  backToStaffSearch(): void {
    if (this.staffEnrollmentLoading) return;
    this.stopEnrollmentCamera();
    this.staffSelectedMember = null;
    this.staffConsent = false;
    this.staffReplaceExisting = false;
    this.staffEnrollmentError = '';
    this.staffEnrollmentSuccess = false;
  }

  registerAnotherStaffMember(): void {
    this.backToStaffSearch();
    this.staffRegistrationAt = '';
  }

  private async verifyStaffSession(): Promise<void> {
    try {
      const profile = await firstValueFrom(this.authService.getProfile());
      this.acceptStaffProfile(profile);
    } catch (error: any) {
      if (error?.status === 401) {
        this.staffAuthStep = 'login';
        this.staffAuthError = '';
      } else {
        this.staffAuthStep = 'unavailable';
        this.staffAuthError = 'Staff authorization could not be verified. Check the connection and retry.';
      }
    } finally {
      this.changeDetector.markForCheck();
    }
  }

  private acceptStaffProfile(profile: any): void {
    const owner = profile?.owner;
    if (!profile?.success || owner?.role !== 'owner') {
      this.staffAuthStep = 'denied';
      this.staffAuthError = 'Only the gym owner or administrator can register a member face.';
      return;
    }
    if (
      !this.gymId ||
      !owner.businessId ||
      String(owner.businessId) !== this.gymId
    ) {
      this.staffAuthStep = 'denied';
      this.staffAuthError = 'This account does not belong to the kiosk gym.';
      return;
    }
    this.staffAuthStep = 'authorized';
    this.staffAuthError = '';
  }

  async authenticateStaff(): Promise<void> {
    const email = this.staffEmail.trim();
    if (this.staffAuthBusy || !email || !this.staffPassword) return;
    this.staffAuthBusy = true;
    this.staffAuthError = '';
    try {
      const response = await firstValueFrom(this.authService.login({
        email,
        password: this.staffPassword
      }));
      if (!response?.success) throw new Error('Staff login was not accepted.');
      const profile = await firstValueFrom(this.authService.getProfile());
      this.acceptStaffProfile(profile);
    } catch (error: any) {
      this.staffAuthStep = 'login';
      this.staffAuthError = error?.error?.message ||
        error?.message ||
        'Staff login failed. Check the account details and try again.';
    } finally {
      this.staffPassword = '';
      this.staffAuthBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  retryStaffAuthorization(): void {
    this.staffAuthStep = 'checking';
    this.staffAuthError = '';
    void this.verifyStaffSession();
  }

  showStaffLogin(): void {
    this.staffAuthStep = 'login';
    this.staffAuthError = '';
  }

  async searchStaffMembers(): Promise<void> {
    const search = this.staffSearchTerm.trim();
    if (
      this.staffAuthStep !== 'authorized' ||
      this.staffSearchLoading ||
      search.length < 2
    ) return;
    const sequence = ++this.staffSearchSequence;
    this.staffSearchLoading = true;
    this.staffSearchError = '';
    this.staffFaceStatusWarning = '';
    this.staffMembers = [];
    this.staffSelectedMember = null;
    try {
      const response = await firstValueFrom(this.memberService.getMembers(search, '', 1, 10));
      const members = Array.isArray(response?.members) ? response.members as StaffMember[] : [];
      const enrichedMembers = await Promise.all(members.map(async member => {
        try {
          const faceStatus = await firstValueFrom(this.memberService.getFaceStatus(member._id));
          return {
            ...member,
            faceStatus: String(faceStatus?.status || 'Unavailable'),
            registeredAt: faceStatus?.registeredAt || null
          };
        } catch {
          return { ...member, faceStatus: 'Unavailable', registeredAt: null };
        }
      }));
      if (sequence !== this.staffSearchSequence) return;
      this.staffMembers = enrichedMembers;
      if (enrichedMembers.some(member => member.faceStatus === 'Unavailable')) {
        this.staffFaceStatusWarning =
          'Face registration status could not be checked for every result. Those members cannot be selected until status is available.';
      }
    } catch {
      if (sequence === this.staffSearchSequence) {
        this.staffSearchError = 'Member search is unavailable. Retry or contact gym staff.';
      }
    } finally {
      if (sequence === this.staffSearchSequence) {
        this.staffSearchLoading = false;
        this.changeDetector.markForCheck();
      }
    }
  }

  selectStaffMember(member: StaffMember): void {
    if (!member.faceStatus || member.faceStatus === 'Unavailable') return;
    this.stopEnrollmentCamera();
    this.staffSelectedMember = member;
    this.staffConsent = false;
    this.staffReplaceExisting = false;
    this.staffEnrollmentError = '';
    this.staffEnrollmentSuccess = false;
    this.staffRegistrationAt = '';
  }

  async startStaffEnrollmentCamera(): Promise<void> {
    const member = this.staffSelectedMember;
    if (
      !member ||
      member.status !== 'Active' ||
      this.staffAuthStep !== 'authorized' ||
      !this.staffConsent ||
      (member.faceStatus !== 'NotRegistered' && !this.staffReplaceExisting) ||
      this.enrollmentCameraActive ||
      this.staffEnrollmentLoading
    ) return;
    this.staffEnrollmentError = '';
    this.enrollmentCameraActive = true;
    this.changeDetector.detectChanges();
    await Promise.resolve();
    try {
      if (!this.staffRegistrationOpen || !this.staffSelectedMember) return;
      if (!this.enrollmentVideoRef) throw new Error('Camera preview could not be rendered.');
      this.enrollmentOwnsCamera = !this.cameraService.hasActiveStream;
      if (this.enrollmentOwnsCamera) {
        await this.cameraService.open(this.enrollmentVideoRef.nativeElement, 'user');
      } else {
        await this.cameraService.attach(this.enrollmentVideoRef.nativeElement);
      }
      if (!this.staffRegistrationOpen || !this.staffSelectedMember) {
        this.stopEnrollmentCamera();
        return;
      }
      this.staffEnrollmentStage = 'Camera ready · Position one face in the guide.';
    } catch (error: any) {
      this.stopEnrollmentCamera();
      this.staffEnrollmentError = error instanceof CameraError
        ? error.message
        : 'Camera is unavailable. Check device access and retry.';
    }
  }

  async captureStaffEnrollment(): Promise<void> {
    const member = this.staffSelectedMember;
    if (
      this.staffEnrollmentLoading ||
      !member ||
      this.staffAuthStep !== 'authorized' ||
      !this.staffConsent ||
      !this.enrollmentCameraActive
    ) return;
    const replaceExisting = member.faceStatus !== 'NotRegistered';
    if (replaceExisting && !this.staffReplaceExisting) {
      this.staffEnrollmentError = 'Confirm replacement of the existing face registration before continuing.';
      return;
    }
    if (
      replaceExisting &&
      !window.confirm(`Replace ${member.fullName}'s existing face registration?`)
    ) return;

    const totalStartedAt = performance.now();
    let modelLoadMs = 0;
    let captureMs = 0;
    let saveMs = 0;
    this.staffEnrollmentLoading = true;
    this.staffEnrollmentError = '';
    this.staffEnrollmentStage = 'Capturing face samples...';
    this.changeDetector.markForCheck();
    try {
      const modelStartedAt = performance.now();
      await this.loadFaceModels(false);
      modelLoadMs = performance.now() - modelStartedAt;
      if (!this.modelsLoaded) {
        throw new Error('Face recognition models could not be loaded. Check the connection and retry.');
      }
      const video = this.enrollmentVideoRef?.nativeElement;
      if (!video) throw new Error('Camera preview is unavailable.');
      const samples: string[] = [];
      let previousBox: { x: number; y: number; width: number; height: number } | null = null;
      const captureStartedAt = performance.now();
      for (let index = 0; index < 3; index += 1) {
        const box = await this.faceRecognition.detectSingleFace(video);
        if (!box) {
          throw new FaceRecognitionError('NO_FACE', 'Position one face inside the guide and hold still.');
        }
        if (
          previousBox &&
          !this.faceRecognition.isStable(previousBox, box, video.videoWidth, video.videoHeight)
        ) {
          throw new FaceRecognitionError('NO_FACE', 'Hold your face steady inside the guide and retry.');
        }
        previousBox = box;
        samples.push(this.faceRecognition.captureImage(video));
        this.staffEnrollmentStage = 'Face detected · Capturing samples...';
        this.changeDetector.markForCheck();
        if (index < 2) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      captureMs = performance.now() - captureStartedAt;
      this.faceRecognition.validateEnrollmentSamples(samples);
      this.staffEnrollmentStage = 'Processing face samples securely...';
      this.changeDetector.markForCheck();
      const saveStartedAt = performance.now();
      const response = await firstValueFrom(this.memberService.registerFaceFromKiosk(
        member._id,
        samples,
        'kiosk-staff-face-consent-v1',
        this.staffConsent,
        this.token,
        replaceExisting
      ));
      saveMs = performance.now() - saveStartedAt;
      if (response?.success !== true || response?.status !== 'Registered') {
        throw new Error('The server did not confirm face registration.');
      }
      this.staffEnrollmentSuccess = true;
      this.staffRegistrationAt = response.registeredAt || '';
      this.staffEnrollmentStage = 'Face registered successfully.';
      this.staffSelectedMember = {
        ...member,
        faceStatus: 'Registered',
        registeredAt: this.staffRegistrationAt || null
      };
      this.stopEnrollmentCamera();
    } catch (error: any) {
      const code = error?.error?.code;
      if (code === 'STAFF_AUTH_REQUIRED' || code?.startsWith('SESSION_')) {
        this.staffAuthStep = 'login';
        this.staffAuthError = 'Your staff session expired. Sign in again to continue.';
      } else if (code === 'STAFF_GYM_MISMATCH') {
        this.staffAuthStep = 'denied';
        this.staffAuthError = 'This account does not belong to the kiosk gym.';
      } else if (code?.startsWith('KIOSK_') || error?.status === 401) {
        this.stopCamera();
        this.clearKioskSession();
        this.stopEnrollmentCamera();
        this.staffRegistrationOpen = false;
        this.authError = 'Kiosk session expired. Please authorize again.';
      }
      this.staffEnrollmentError = this.getEnrollmentErrorMessage(error);
      this.staffEnrollmentStage = this.enrollmentCameraActive
        ? 'Camera ready · Retry capture when ready.'
        : '';
    } finally {
      this.staffEnrollmentLoading = false;
      this.logPerformance('staff-face-enrollment', {
        modelLoadMs,
        captureAndTemplateMs: captureMs,
        saveMs,
        totalMs: performance.now() - totalStartedAt
      });
      this.changeDetector.markForCheck();
    }
  }

  private stopEnrollmentCamera(): void {
    if (this.enrollmentVideoRef?.nativeElement) {
      if (this.enrollmentOwnsCamera) this.cameraService.stop();
      else this.cameraService.detach(this.enrollmentVideoRef.nativeElement);
    } else if (this.enrollmentOwnsCamera) {
      this.cameraService.stop();
    }
    this.enrollmentOwnsCamera = false;
    this.enrollmentCameraActive = false;
  }

  private getEnrollmentErrorMessage(error: any): string {
    const code = error?.error?.code;
    if (error instanceof FaceRecognitionError) {
      return error.message;
    }
    if (error?.status === 0) return 'Network connection failed. Check the connection and retry.';
    if (code === 'ENROLLMENT_TOKEN_INVALID') {
      return 'Enrollment authorization expired. Please verify the member again.';
    }
    if (code === 'STAFF_ENROLLMENT_REQUIRED') {
      return 'Face registration must be completed by gym staff after verifying the member.';
    }
    if (error?.status === 401) {
      return 'Kiosk session expired. Please authorize again.';
    }
    if (code === 'KIOSK_AUTH_UNAVAILABLE') {
      return 'Kiosk authorization is temporarily unavailable. Please contact gym staff.';
    }
    if (
      code === 'BIOMETRIC_ENCRYPTION_UNAVAILABLE' ||
      code === 'BIOMETRIC_RECOGNITION_UNAVAILABLE' ||
      code === 'BIOMETRIC_SERVICE_UNAVAILABLE'
    ) {
      return 'Face registration is temporarily unavailable. Please contact gym staff.';
    }
    if (code === 'FACE_ALREADY_REGISTERED') return 'This member already has a registered face. Ask gym staff to update it.';
    if (code === 'FACE_REREGISTRATION_REQUIRED') {
      return 'This face registration must be updated using the current recognition model.';
    }
    if (code === 'DUPLICATE_FACE_DETECTED') {
      return 'This face is already registered with another member. Please contact gym staff.';
    }
    if (code === 'MEMBER_NOT_FOUND') return 'Member not found.';
    if (code === 'STAFF_GYM_MISMATCH') return 'This account does not belong to the kiosk gym.';
    if (code === 'CONSENT_REQUIRED') return 'Consent is required before registering a face.';
    if (code === 'INVALID_FACE_DESCRIPTOR') {
      const safeBackendMessage = error?.error?.message;
      if ([
        'A valid 128-value face template is required.',
        'The recognition model did not produce a valid 128-value face template.',
        'The generated face template failed backend validation. Check backend biometric diagnostics.'
      ].includes(safeBackendMessage)) {
        return safeBackendMessage;
      }
      return 'Face template generation failed. Please retry or contact gym staff.';
    }
    if (
      code === 'INVALID_FACE_IMAGE' ||
      code === 'INVALID_FACE_IMAGES' ||
      code === 'INVALID_FACE_TEMPLATE' ||
      code === 'NO_FACE' ||
      code === 'MULTIPLE_FACES' ||
      code === 'FACE_TOO_SMALL' ||
      code === 'INCOMPATIBLE_FACE_MODEL' ||
      code === 'BIOMETRIC_VALIDATION_FAILED'
    ) {
      return 'Unable to process face. Please try again.';
    }
    if (code === 'BIOMETRIC_SAVE_FAILED' || error?.status >= 500) {
      return 'Unable to save face registration. Please retry.';
    }
    if (error?.status === 400) return 'Unable to process face. Please try again.';
    return 'Unable to register face. Please retry.';
  }

  private logPerformance(
    phase: string,
    timings: Record<string, number>
  ): void {
    if (!environment.production) {
      console.debug(`[kiosk-performance] ${phase}`, timings);
    }
  }

  private startRenewalTimer(): void {
    if (this.kioskRenewTimer) clearInterval(this.kioskRenewTimer);
    this.kioskRenewTimer = setInterval(() => void this.renewStoredSession(), 10 * 60 * 1000);
  }

  private async renewStoredSession(): Promise<void> {
    const refreshToken = localStorage.getItem(this.refreshStorageKey);
    if (!refreshToken) return;
    try {
      const response = await this.http.post<any>(`${environment.apiUrl}/kiosk/renew`, {
        refreshToken
      }).toPromise();
      if (response?.success !== true || !response.token || !response.refreshToken) {
        throw new Error('Renewal response was incomplete.');
      }
      this.token = response.token;
      sessionStorage.setItem('ssfm_kiosk_token', this.token);
      localStorage.setItem(this.refreshStorageKey, response.refreshToken);
      this.authorized = true;
      this.startRenewalTimer();
      await this.validateStoredSessionAsync();
    } catch (error: any) {
      if (error?.status === 401 || error?.status === 403) {
        this.clearKioskSession();
        this.authError = error.error?.message || 'Kiosk authorization expired. Please authorize again.';
        this.changeDetector.markForCheck();
      }
    }
  }

  private async validateStoredSessionAsync(): Promise<void> {
    await this.http.get<any>(`${environment.apiUrl}/kiosk/config`, {
      headers: this.kioskHeaders()
    }).toPromise().then(response => {
      this.applyGymConfig(response.gym || {});
      this.authorized = true;
      this.changeDetector.markForCheck();
    }).catch(() => this.clearKioskSession());
  }

  async requestWakeLock(): Promise<void> {
    try {
      if (!this.authorized || !('wakeLock' in navigator)) return;
      if (this.wakeLock) return;
      this.wakeLock = await (navigator as any).wakeLock.request('screen');
      this.wakeLock?.addEventListener?.('release', () => {
        this.wakeLock = null;
      });
    } catch {
      this.wakeLock = null;
    }
  }

  private async releaseWakeLock(): Promise<void> {
    try {
      await this.wakeLock?.release();
    } catch {
      // Wake lock support is optional and must not affect kiosk authorization.
    }
    this.wakeLock = null;
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible' && this.authorized) {
      void this.requestWakeLock();
    }
  };

  private readonly onNetworkStatusChange = (): void => {
    this.networkOnline = navigator.onLine;
    this.changeDetector.markForCheck();
  };

  async startFaceScan(): Promise<void> {
    if (!this.authorized || !this.faceEnabled || this.scanning || this.staffRegistrationOpen) return;
    const scanStartedAt = performance.now();
    this.result = null;
    this.cameraError = '';
    this.scanning = true;
    try {
      await this.startCamera();
      if (!this.cameraActive) {
        this.scanning = false;
        return;
      }
      await this.loadFaceModels();
      if (!this.modelsLoaded) {
        this.scanning = false;
        return;
      }
      await this.captureAndIdentify();
    } finally {
      this.scanning = false;
      this.logPerformance('face-scan-total', { totalMs: performance.now() - scanStartedAt });
    }
  }

  private async startCamera(): Promise<void> {
    if (this.cameraActive) return;
    this.cameraActive = true;
    this.changeDetector.detectChanges();
    await Promise.resolve();
    try {
      if (!this.videoRef) throw new Error('Camera preview could not be rendered.');
      await this.cameraService.open(this.videoRef.nativeElement, 'user');
      this.cameraStatus = 'Camera ready';
      this.faceStatus = 'Please look directly at the camera';
    } catch (error: any) {
      this.stopCamera();
      this.cameraStatus = 'Camera unavailable';
      this.showCameraError(error instanceof CameraError
        ? error.message
        : 'The camera could not be started. Retry after checking device access.');
    }
  }

  retryCamera(): void {
    this.stopCamera();
    void this.startKioskCamera();
  }

  private async startKioskCamera(): Promise<void> {
    await this.startCamera();
    if (!this.cameraActive) return;
    await this.loadFaceModels();
    if (!this.modelsLoaded) return;
    this.startContinuousScanning();
  }

  private startContinuousScanning(): void {
    if (this.continuousScanTimer) clearInterval(this.continuousScanTimer);
    this.continuousScanTimer = setInterval(() => {
      if (
        this.authorized &&
        this.faceEnabled &&
        this.cameraActive &&
        !this.scanning &&
        !this.continuousScanInProgress &&
        !this.result &&
        !this.staffRegistrationOpen &&
        Date.now() >= this.recognitionCooldownUntil
      ) {
        void this.captureContinuousFace();
      }
    }, 700);
  }

  private async captureContinuousFace(): Promise<void> {
    if (this.continuousScanInProgress) return;
    this.continuousScanInProgress = true;
    try {
      const video = this.videoRef?.nativeElement;
      if (!video || !this.modelsLoaded) return;
      const box = await this.faceRecognition.detectSingleFace(video);
      if (!box) {
        this.previousScanFaceBox = null;
        return;
      }
      if (
        !this.previousScanFaceBox ||
        !this.faceRecognition.isStable(
          this.previousScanFaceBox,
          box,
          video.videoWidth,
          video.videoHeight
        )
      ) {
        this.previousScanFaceBox = box;
        return;
      }
      this.previousScanFaceBox = null;
      const image = this.faceRecognition.captureImage(video);
      const identifyStartedAt = performance.now();
      const identify = await this.http.post<any>(
        `${environment.apiUrl}/kiosk/face/identify`,
        { image },
        { headers: this.kioskHeaders() }
      ).toPromise();
      const identifyMs = performance.now() - identifyStartedAt;
      this.logPerformance('continuous-face-recognition', { identifyMs });
      if (this.staffRegistrationOpen || !identify?.success || !identify.matchToken) return;
      await this.checkIn(identify.member.id, identify.matchToken);
      this.recognitionCooldownUntil = Date.now() + 7000;
    } catch (error: any) {
      if (error?.status === 401) {
        this.clearKioskSession();
        this.showResult({ type: 'error', title: 'Kiosk session expired', message: 'Authorize the kiosk again.' });
      } else if (error?.error?.code === 'MEMBER_INACTIVE') {
        this.showResult({
          type: 'error',
          title: 'MEMBER ACCESS DENIED',
          message: 'This member is inactive or blocked. Please contact gym staff.'
        });
      } else {
        this.cameraStatus = this.getSafeFaceVerificationMessage(error);
      }
    } finally {
      this.continuousScanInProgress = false;
      this.changeDetector.markForCheck();
    }
  }

  private async loadFaceModels(showCameraError = true): Promise<void> {
    if (this.modelsLoaded) return;
    this.modelsLoading = true;
    this.faceStatus = 'Loading face detection model...';
    try {
      await this.faceRecognition.load();
      this.modelsLoaded = true;
    } catch (error) {
      const message = error instanceof FaceRecognitionError
        ? error.message
        : 'Face detection could not be loaded. Check the connection and retry.';
      if (showCameraError) this.showCameraError(message);
      else this.faceStatus = message;
    } finally {
      this.modelsLoading = false;
    }
  }

  private async captureAndIdentify(): Promise<void> {
    const video = this.videoRef?.nativeElement;
    if (!video) return;
    this.faceStatus = 'Verifying identity...';
    try {
      let image: string;
      try {
        image = await this.faceRecognition.captureFromStableFace(video);
      } catch (error) {
        if (!(error instanceof FaceRecognitionError) || error.code !== 'NO_FACE') throw error;
        this.showResult({
          type: 'not-found',
          title: 'Face not detected',
          message: 'Move closer, improve the lighting, and look directly at the camera.'
        });
        this.scanning = false;
        return;
      }
      const identifyStartedAt = performance.now();
      const identify = await this.http.post<any>(
        `${environment.apiUrl}/kiosk/face/identify`,
        { image },
        { headers: this.kioskHeaders() }
      ).toPromise();
      const identifyMs = performance.now() - identifyStartedAt;
      this.logPerformance('face-recognition', { identifyMs });
      if (!identify?.success) throw new Error(identify?.message || 'Member not recognized');
      if (!identify.matchToken) throw new Error('The server did not return a face-match proof.');
      await this.checkIn(identify.member.id, identify.matchToken);
    } catch (error: any) {
      if (error?.error?.code === 'FACE_NOT_REGISTERED' || error?.error?.code === 'UNKNOWN_FACE') {
        this.showResult({
          type: 'not-found',
          title: 'Face Not Recognized',
          message: 'Face not recognized. Please try again.'
        });
      } else if (error?.status === 404 || error?.error?.code === 'MEMBER_NOT_RECOGNIZED') {
        this.showResult({
          type: 'not-found',
          title: 'Member Not Recognized',
          message: 'Face not recognized. Please try again.',
        });
      } else if (
        error?.error?.code === 'AMBIGUOUS_FACE' ||
        error?.error?.code === 'DUPLICATE_BIOMETRIC_IDENTITY'
      ) {
        this.showResult({
          type: 'error',
          title: 'Unable to Verify Identity',
          message: 'Unable to verify identity. Please reposition your face.'
        });
      } else if (error?.status === 401) {
        this.clearKioskSession();
        this.showResult({ type: 'error', title: 'Kiosk session expired', message: 'Authorize the kiosk again.' });
      } else {
        this.showResult({
          type: 'error',
          title: 'Verification unavailable',
          message: this.getSafeFaceVerificationMessage(error)
        });
      }
    } finally {
      this.scanning = false;
      this.stopCamera();
    }
  }

  private async checkIn(memberId: string, matchToken: string): Promise<void> {
    const startedAt = performance.now();
    const idempotencyKey = crypto.randomUUID();
    try {
      const response = await this.http.post<any>(
        `${environment.apiUrl}/kiosk/attendance/check-in`,
        { memberId, idempotencyKey, matchToken },
        { headers: this.kioskHeaders() }
      ).toPromise();
      this.showResult({
        type: 'success',
        title: 'CHECK-IN SUCCESSFUL',
        message: 'Welcome! Your attendance has been recorded.',
        memberName: response.member?.fullName,
        memberId: response.member?.id,
        time: response.checkInTime ? new Date(response.checkInTime).toLocaleTimeString('en-IN') : '',
        membershipPlan: response.membership?.planName,
        validUntil: response.membership?.validUntil
          ? new Date(response.membership.validUntil).toLocaleDateString('en-IN')
          : undefined
      });
    } catch (error: any) {
      const code = error?.error?.code;
      if (error?.status === 401) {
        this.clearKioskSession();
        this.showResult({ type: 'error', title: 'Kiosk session expired', message: 'Authorize the kiosk again.' });
        return;
      }
      if (code === 'MEMBERSHIP_EXPIRED') {
        this.showResult({
          type: 'expired',
          title: 'MEMBERSHIP EXPIRED',
          message: 'Your membership has expired. Kindly contact the gym owner to renew your membership.',
          memberName: error.error.member?.fullName,
          expiryDate: error.error.expiryDate ? new Date(error.error.expiryDate).toLocaleDateString('en-IN') : undefined
        });
      } else if (code === 'ALREADY_CHECKED_IN') {
        this.showResult({
          type: 'duplicate',
          title: 'ATTENDANCE ALREADY MARKED',
          message: 'You are already checked in today.',
          memberName: error.error.member?.fullName,
          time: error.error.checkInTime ? new Date(error.error.checkInTime).toLocaleTimeString('en-IN') : ''
        });
      } else if (code === 'MEMBER_INACTIVE') {
        this.showResult({
          type: 'error',
          title: 'MEMBER ACCESS DENIED',
          message: 'This member is inactive or blocked. Please contact gym staff.',
          memberName: error.error.member?.fullName
        });
      } else {
        this.showResult({
          type: 'error',
          title: 'Attendance not marked',
          message: 'Unable to mark attendance. Please try again or use QR check-in.'
        });
      }
    } finally {
      this.logPerformance('attendance-check-in', { serverRoundTripMs: performance.now() - startedAt });
    }
  }

  private kioskHeaders(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this.token}` });
  }

  private getSafeFaceVerificationMessage(error: any): string {
    const code = error?.error?.code;
    if (
      code === 'UNKNOWN_FACE' ||
      code === 'FACE_NOT_REGISTERED' ||
      code === 'NO_FACE' ||
      error?.status === 404
    ) {
      return 'Face not recognized. Please try again.';
    }
    if (
      code === 'AMBIGUOUS_FACE' ||
      code === 'DUPLICATE_BIOMETRIC_IDENTITY' ||
      code === 'MULTIPLE_FACES' ||
      code === 'FACE_TOO_SMALL'
    ) {
      return 'Unable to verify identity. Please reposition your face.';
    }
    if (code === 'INVALID_FACE_IMAGE') {
      return 'Unable to process face. Please try again.';
    }
    if (error?.status === 0 || error?.status >= 500) {
      return 'Biometric service is temporarily unavailable.';
    }
    return 'Unable to verify identity. Please reposition your face.';
  }

  private clearKioskSession(): void {
    sessionStorage.removeItem('ssfm_kiosk_token');
    sessionStorage.removeItem('ssfm_kiosk_gym');
    localStorage.removeItem(this.refreshStorageKey);
    this.token = '';
    this.authorized = false;
    this.gymId = '';
    this.faceEnabled = false;
    this.faceEnrollmentEnabled = false;
    this.faceEnrollmentRequiresStaff = false;
    this.qrEnabled = false;
  }

  private showCameraError(message: string): void {
    this.stopCamera();
    this.cameraError = message;
    this.showResult({ type: 'camera', title: 'Camera unavailable', message });
  }

  private showResult(result: KioskResult): void {
    this.result = result;
    if (this.resultTimer) clearTimeout(this.resultTimer);
    this.resultTimer = setTimeout(() => {
      this.result = null;
      this.changeDetector.markForCheck();
    }, 5000);
  }

  retryScan(): void {
    this.result = null;
    void this.startFaceScan();
  }

  async qrCheckIn(): Promise<void> {
    if (!this.qrEnabled || this.staffRegistrationOpen) return;
    const qrToken = window.prompt('Scan or enter the member QR token');
    if (!qrToken?.trim()) return;
    try {
      const response = await this.http.post<any>(
        `${environment.apiUrl}/kiosk/qr/check-in`,
        { qrToken: qrToken.trim() },
        { headers: this.kioskHeaders() }
      ).toPromise();
      this.showResult({
        type: 'success',
        title: 'ATTENDANCE CHECK-IN SUCCESSFUL',
        message: 'Welcome! Your attendance has been recorded.',
        memberName: response.member?.fullName,
        memberId: response.member?.id,
        time: response.checkInTime ? new Date(response.checkInTime).toLocaleTimeString('en-IN') : '',
        membershipPlan: response.membership?.planName,
        validUntil: response.membership?.validUntil
          ? new Date(response.membership.validUntil).toLocaleDateString('en-IN')
          : undefined
      });
    } catch (error: any) {
      const code = error?.error?.code;
      if (error?.status === 401) {
        this.clearKioskSession();
        this.showResult({ type: 'error', title: 'Kiosk session expired', message: 'Authorize the kiosk again.' });
        return;
      }
      if (code === 'MEMBERSHIP_EXPIRED') {
        this.showResult({
          type: 'expired',
          title: 'MEMBERSHIP EXPIRED',
          message: 'Your membership has expired. Kindly contact the gym owner to renew your membership.',
          memberName: error.error.member?.fullName,
          expiryDate: error.error.expiryDate ? new Date(error.error.expiryDate).toLocaleDateString('en-IN') : undefined
        });
      } else if (code === 'ALREADY_CHECKED_IN') {
        this.showResult({
          type: 'duplicate',
          title: 'ATTENDANCE ALREADY MARKED',
          message: 'You are already checked in today.',
          memberName: error.error.member?.fullName,
          time: error.error.checkInTime ? new Date(error.error.checkInTime).toLocaleTimeString('en-IN') : ''
        });
      } else if (code === 'MEMBER_INACTIVE') {
        this.showResult({
          type: 'error',
          title: 'MEMBER ACCESS DENIED',
          message: 'This member is inactive or blocked. Please contact gym staff.',
          memberName: error.error.member?.fullName
        });
      } else {
        this.showResult({
          type: 'error',
          title: 'QR check-in failed',
          message: error?.error?.message || 'Unable to mark QR attendance.'
        });
      }
    }
  }

  closeResult(): void {
    if (this.resultTimer) clearTimeout(this.resultTimer);
    this.result = null;
  }

  private stopCamera(): void {
    this.cameraService.stop();
    if (this.continuousScanTimer) {
      clearInterval(this.continuousScanTimer);
      this.continuousScanTimer = null;
    }
    if (this.videoRef?.nativeElement) this.videoRef.nativeElement.srcObject = null;
    this.cameraActive = false;
  }
}
