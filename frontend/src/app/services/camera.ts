import { Injectable } from '@angular/core';

export type CameraErrorCode =
  | 'NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'NOT_READABLE'
  | 'OVERCONSTRAINED'
  | 'SECURITY'
  | 'UNSUPPORTED'
  | 'PREVIEW_UNAVAILABLE';

export class CameraError extends Error {
  constructor(
    public readonly code: CameraErrorCode,
    message: string
  ) {
    super(message);
  }
}

@Injectable({ providedIn: 'root' })
export class CameraService {
  private stream: MediaStream | null = null;
  private opening = false;

  get activeStream(): MediaStream | null {
    return this.stream;
  }

  async open(
    video: HTMLVideoElement,
    preferredFacingMode: 'user' | 'environment' = 'user'
  ): Promise<MediaStream> {
    if (this.opening) throw new CameraError('NOT_READABLE', 'Camera setup is already in progress.');
    if (!window.isSecureContext) {
      throw new CameraError(
        'SECURITY',
        'Camera access requires HTTPS or an eligible localhost address.'
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError(
        'UNSUPPORTED',
        'This browser does not support camera access.'
      );
    }

    this.opening = true;
    this.stop();
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: preferredFacingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        });
      } catch (error: any) {
        if (error?.name === 'OverconstrainedError') {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: preferredFacingMode }
          });
        } else {
          throw error;
        }
      }

      video.srcObject = stream;
      await this.waitForMetadata(video);
      await video.play().catch(error => {
        if (error?.name !== 'AbortError') throw error;
      });
      this.stream = stream;
      return stream;
    } catch (error: any) {
      this.stop();
      throw this.normalizeError(error);
    } finally {
      this.opening = false;
    }
  }

  stop(): void {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
  }

  private waitForMetadata(video: HTMLVideoElement): Promise<void> {
    if (video.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new CameraError('PREVIEW_UNAVAILABLE', 'The camera preview timed out.'));
      }, 10_000);
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new CameraError('PREVIEW_UNAVAILABLE', 'The camera preview could not be initialized.'));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
    });
  }

  private normalizeError(error: any): CameraError {
    switch (error?.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return new CameraError(
          'NOT_ALLOWED',
          'Camera permission was denied. Allow camera access in browser settings and retry.'
        );
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return new CameraError(
          'NOT_FOUND',
          'No camera device was found. Connect or enable a camera and retry.'
        );
      case 'NotReadableError':
      case 'TrackStartError':
        return new CameraError(
          'NOT_READABLE',
          'The camera is already in use or unavailable. Close other camera apps and retry.'
        );
      case 'OverconstrainedError':
      case 'ConstraintNotSatisfiedError':
        return new CameraError(
          'OVERCONSTRAINED',
          'The preferred camera constraints are unavailable. Retry with the browser default camera.'
        );
      case 'SecurityError':
        return new CameraError(
          'SECURITY',
          'Camera access is blocked by browser security settings.'
        );
      default:
        if (error instanceof CameraError) return error;
        return new CameraError(
          'NOT_READABLE',
          'The camera could not be started. Check device availability and retry.'
        );
    }
  }
}
