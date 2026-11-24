import { FaceRecognitionService, FaceRecognitionError } from './face-recognition';

describe('FaceRecognitionService enrollment payload validation', () => {
  const service = new FaceRecognitionService();
  const validJpeg = 'data:image/jpeg;base64,/9j/2Q==';

  it('accepts three bounded JPEG samples', () => {
    expect(() => service.validateEnrollmentSamples([
      validJpeg,
      validJpeg,
      validJpeg
    ])).not.toThrow();
  });

  it('rejects missing samples and non-JPEG or oversized payloads before submission', () => {
    expect(() => service.validateEnrollmentSamples([validJpeg])).toThrow(FaceRecognitionError);
    expect(() => service.validateEnrollmentSamples([
      validJpeg,
      'data:image/png;base64,AAAA',
      validJpeg
    ])).toThrow(FaceRecognitionError);
    expect(() => service.validateEnrollmentSamples([
      validJpeg,
      validJpeg,
      `data:image/jpeg;base64,${'A'.repeat(3_000_000)}`
    ])).toThrow(FaceRecognitionError);
  });
});
