import { CommonModule } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { finalize } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CameraError, CameraService } from '../../services/camera';

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
  faceEnabled = false;
  qrEnabled = false;
  now = new Date();
  clockTimer: ReturnType<typeof setInterval> | null = null;

  cameraActive = false;
  cameraError = '';
  cameraStatus = 'Camera idle';
  selfRegistrationOpen = false;
  selfIdentifier = '';
  selfMember: { id: string; displayId?: string; name: string } | null = null;
  selfEnrollmentToken = '';
  selfConsent = false;
  selfEnrollmentError = '';
  selfEnrollmentLoading = false;
  selfEnrollmentSuccess = '';
  enrollmentCameraActive = false;
  scanning = false;
  modelsLoading = false;
  faceStatus = 'Start Face Scan';
  result: KioskResult | null = null;
  accessDenied = false;
  networkOnline = navigator.onLine;

  private faceApi: any = null;
  private modelsLoaded = false;
  private wakeLock: any = null;
  private kioskRenewTimer: ReturnType<typeof setInterval> | null = null;
  private continuousScanTimer: ReturnType<typeof setInterval> | null = null;
  private continuousScanInProgress = false;
  private recognitionCooldownUntil = 0;
  private resultTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly route: ActivatedRoute,
    private readonly cameraService: CameraService,
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
        if (this.faceEnabled) void this.startKioskCamera();
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
        if (this.faceEnabled) void this.startKioskCamera();
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
    this.faceEnabled = Boolean(gym.faceAttendanceEnabled);
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

  openSelfRegistration(): void {
    if (!this.authorized) return;
    this.selfRegistrationOpen = true;
    this.selfIdentifier = '';
    this.selfMember = null;
    this.selfEnrollmentToken = '';
    this.selfConsent = false;
    this.selfEnrollmentError = '';
    this.selfEnrollmentSuccess = '';
    this.changeDetector.markForCheck();
  }

  closeSelfRegistration(): void {
    this.stopEnrollmentCamera();
    this.selfRegistrationOpen = false;
    this.selfMember = null;
    this.selfEnrollmentToken = '';
    this.selfConsent = false;
  }

  identifyMemberForEnrollment(): void {
    const identifier = this.selfIdentifier.trim();
    if (!identifier || this.selfEnrollmentLoading) return;
    this.selfEnrollmentLoading = true;
    this.selfEnrollmentError = '';
    this.http.post<any>(
      `${environment.apiUrl}/kiosk/enrollment/identify-member`,
      { identifier },
      { headers: this.kioskHeaders() }
    ).subscribe({
      next: response => {
        this.selfEnrollmentLoading = false;
        if (response?.success !== true) {
          this.selfEnrollmentError = response?.message || 'Unable to verify the member.';
          return;
        }
        this.selfMember = response.member || null;
        this.selfEnrollmentToken = response.enrollmentToken || '';
        this.changeDetector.markForCheck();
      },
      error: error => {
        this.selfEnrollmentLoading = false;
        this.selfMember = null;
        this.selfEnrollmentToken = '';
        this.selfEnrollmentError = error.error?.message || 'Member Not Found. Please contact gym staff.';
        this.changeDetector.markForCheck();
      }
    });
  }

  async startEnrollmentCamera(): Promise<void> {
    if (!this.selfMember || !this.selfConsent || this.enrollmentCameraActive) return;
    this.selfEnrollmentError = '';
    this.enrollmentCameraActive = true;
    this.changeDetector.detectChanges();
    await Promise.resolve();
    try {
      if (!this.enrollmentVideoRef) throw new Error('Camera preview could not be rendered.');
      await this.cameraService.open(this.enrollmentVideoRef.nativeElement, 'user');
    } catch (error: any) {
      this.stopEnrollmentCamera();
      this.selfEnrollmentError = error instanceof CameraError
        ? error.message
        : 'Camera is unavailable.';
    }
  }

  async captureSelfEnrollment(): Promise<void> {
    if (
      this.selfEnrollmentLoading ||
      !this.selfMember ||
      !this.selfEnrollmentToken ||
      !this.selfConsent ||
      !this.enrollmentCameraActive
    ) return;
    this.selfEnrollmentLoading = true;
    this.selfEnrollmentError = '';
    try {
      const faceApi = await import('face-api.js');
      await Promise.all([
        faceApi.nets.tinyFaceDetector.loadFromUri('/models'),
        faceApi.nets.faceLandmark68Net.loadFromUri('/models'),
        faceApi.nets.faceRecognitionNet.loadFromUri('/models')
      ]);
      const video = this.enrollmentVideoRef?.nativeElement;
      if (!video) throw new Error('Camera preview is unavailable.');
      const samples: number[][] = [];
      for (let index = 0; index < 3; index += 1) {
        const detections = await faceApi
          .detectAllFaces(video, new faceApi.TinyFaceDetectorOptions({
            inputSize: 320,
            scoreThreshold: 0.6
          }))
          .withFaceLandmarks()
          .withFaceDescriptors();
        if (detections.length !== 1) {
          throw new Error(detections.length === 0
            ? 'No face was detected. Position yourself in the guide.'
            : 'More than one face is visible. Ensure only you are in view.');
        }
        samples.push(Array.from(detections[0].descriptor));
        if (index < 2) await new Promise(resolve => setTimeout(resolve, 350));
      }
      const descriptor = samples[0].map((_, index) =>
        samples.reduce((sum, sample) => sum + sample[index], 0) / samples.length
      );
      const response = await this.http.post<any>(
        `${environment.apiUrl}/kiosk/enrollment/face`,
        {
          descriptor,
          enrollmentToken: this.selfEnrollmentToken,
          consentGranted: true
        },
        { headers: this.kioskHeaders() }
      ).toPromise();
      if (response?.success !== true) {
        throw new Error(response?.message || 'Unable to register face.');
      }
      this.selfEnrollmentSuccess = 'FACE REGISTERED SUCCESSFULLY';
      this.stopEnrollmentCamera();
      window.setTimeout(() => this.closeSelfRegistration(), 1800);
    } catch (error: any) {
      this.selfEnrollmentError = error.error?.message || error?.message || 'Unable to register face.';
    } finally {
      this.selfEnrollmentLoading = false;
      this.changeDetector.markForCheck();
    }
  }

  private stopEnrollmentCamera(): void {
    this.cameraService.stop();
    if (this.enrollmentVideoRef?.nativeElement) {
      this.enrollmentVideoRef.nativeElement.srcObject = null;
    }
    this.enrollmentCameraActive = false;
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
      if (!this.cameraActive && this.faceEnabled) void this.startKioskCamera();
    }
  };

  private readonly onNetworkStatusChange = (): void => {
    this.networkOnline = navigator.onLine;
    this.changeDetector.markForCheck();
  };

  async startFaceScan(): Promise<void> {
    if (!this.authorized || !this.faceEnabled || this.scanning) return;
    this.result = null;
    this.cameraError = '';
    this.scanning = true;
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
        !this.selfRegistrationOpen &&
        Date.now() >= this.recognitionCooldownUntil
      ) {
        void this.captureContinuousFace();
      }
    }, 3000);
  }

  private async captureContinuousFace(): Promise<void> {
    if (this.continuousScanInProgress) return;
    this.continuousScanInProgress = true;
    try {
      const video = this.videoRef?.nativeElement;
      if (!video || !this.faceApi) return;
      const detections = await this.faceApi
        .detectAllFaces(video, new this.faceApi.TinyFaceDetectorOptions({
          inputSize: 320,
          scoreThreshold: 0.6
        }))
        .withFaceLandmarks()
        .withFaceDescriptors();
      if (detections.length !== 1) return;
      const descriptor = Array.from(detections[0].descriptor as Float32Array);
      const identify = await this.http.post<any>(
        `${environment.apiUrl}/kiosk/face/identify`,
        { descriptor },
        { headers: this.kioskHeaders() }
      ).toPromise();
      if (!identify?.success || !identify.matchToken) return;
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
      } else if (error?.status !== 404) {
        this.cameraStatus = error?.error?.message || 'Recognition temporarily unavailable';
      }
    } finally {
      this.continuousScanInProgress = false;
      this.changeDetector.markForCheck();
    }
  }

  private async loadFaceModels(): Promise<void> {
    if (this.modelsLoaded) return;
    this.modelsLoading = true;
    this.faceStatus = 'Loading face recognition model...';
    try {
      this.faceApi = await import('face-api.js');
      await Promise.all([
        this.faceApi.nets.tinyFaceDetector.loadFromUri('/models'),
        this.faceApi.nets.faceLandmark68Net.loadFromUri('/models'),
        this.faceApi.nets.faceRecognitionNet.loadFromUri('/models')
      ]);
      this.modelsLoaded = true;
    } catch (error) {
      this.showCameraError('Face recognition models could not be loaded. Check the connection and retry.');
    } finally {
      this.modelsLoading = false;
    }
  }

  private async captureAndIdentify(): Promise<void> {
    const video = this.videoRef?.nativeElement;
    if (!video) return;
    this.faceStatus = 'Verifying identity...';
    try {
      const detected = await this.faceApi
        .detectSingleFace(video, new this.faceApi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.6 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!detected) {
        this.showResult({
          type: 'not-found',
          title: 'Face not detected',
          message: 'Move closer, improve the lighting, and look directly at the camera.'
        });
        this.scanning = false;
        return;
      }
      const descriptor = Array.from(detected.descriptor as Float32Array);
      const identify = await this.http.post<any>(
        `${environment.apiUrl}/kiosk/face/identify`,
        { descriptor },
        { headers: this.kioskHeaders() }
      ).toPromise();
      if (!identify?.success) throw new Error(identify?.message || 'Member not recognized');
      if (!identify.matchToken) throw new Error('The server did not return a face-match proof.');
      await this.checkIn(identify.member.id, identify.matchToken);
    } catch (error: any) {
      if (error?.error?.code === 'FACE_NOT_REGISTERED') {
        this.showResult({
          type: 'not-found',
          title: 'Face Not Registered',
          message: 'Your face is not registered. Please use Register Face or contact gym staff.'
        });
      } else if (error?.status === 404 || error?.error?.code === 'MEMBER_NOT_RECOGNIZED') {
        this.showResult({
          type: 'not-found',
          title: 'Member Not Recognized',
          message: 'Please retry or use QR check-in.',
        });
      } else if (error?.status === 401) {
        this.clearKioskSession();
        this.showResult({ type: 'error', title: 'Kiosk session expired', message: 'Authorize the kiosk again.' });
      } else {
        this.showResult({
          type: 'error',
          title: 'Verification unavailable',
          message: error?.error?.message || 'Unable to verify the face. Please retry.'
        });
      }
    } finally {
      this.scanning = false;
      this.stopCamera();
    }
  }

  private async checkIn(memberId: string, matchToken: string): Promise<void> {
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
          message: error?.error?.message || 'Unable to mark attendance.'
        });
      }
    }
  }

  private kioskHeaders(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this.token}` });
  }

  private clearKioskSession(): void {
    sessionStorage.removeItem('ssfm_kiosk_token');
    sessionStorage.removeItem('ssfm_kiosk_gym');
    localStorage.removeItem(this.refreshStorageKey);
    this.token = '';
    this.authorized = false;
    this.faceEnabled = false;
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
    if (!this.qrEnabled) return;
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
