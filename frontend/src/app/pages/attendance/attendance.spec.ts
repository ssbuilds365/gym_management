import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';

import { Attendance } from './attendance';
import { AttendanceService } from '../../services/attendance';
import { MemberService } from '../../services/member';

describe('Attendance', () => {
  let component: Attendance;
  let fixture: ComponentFixture<Attendance>;
  let attendanceService: {
    getDailyAttendance: ReturnType<typeof vi.fn>;
    checkIn: ReturnType<typeof vi.fn>;
    checkOut: ReturnType<typeof vi.fn>;
    checkInWithQR: ReturnType<typeof vi.fn>;
  };
  let memberService: {
    getMembers: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    attendanceService = {
      getDailyAttendance: vi.fn().mockReturnValue(of({ attendance: [] })),
      checkIn: vi.fn(),
      checkOut: vi.fn(),
      checkInWithQR: vi.fn()
    };
    memberService = {
      getMembers: vi.fn().mockReturnValue(of({ members: [] }))
    };

    await TestBed.configureTestingModule({
      imports: [Attendance],
      providers: [
        { provide: AttendanceService, useValue: attendanceService },
        { provide: MemberService, useValue: memberService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(Attendance);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('rejects unsupported gallery image types without calling attendance API', async () => {
    const file = new File(['not an image'], 'member.gif', { type: 'image/gif' });
    const input = { files: [file], value: 'member.gif' } as unknown as HTMLInputElement;

    await component.onQRImageSelected({ target: input } as unknown as Event);

    expect(component.errorMessage).toBe('Please select a JPG, JPEG, PNG, or WebP image.');
    expect(attendanceService.checkInWithQR).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('sends a decoded gallery QR payload through the existing QR attendance API', async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn().mockReturnValue('blob:member-qr')
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn()
    });
    const loadImage = vi.spyOn(component as any, 'loadQRImage')
      .mockResolvedValue({} as HTMLImageElement);
    const decodeImage = vi.spyOn(component as any, 'decodeQRImage')
      .mockResolvedValue('existing-member-qr-payload');
    attendanceService.checkInWithQR.mockReturnValue(of({
      message: 'Attendance marked successfully',
      member: { fullName: 'Test Member' }
    }));
    component.qrScannerOpen = true;
    const file = new File(['image'], 'member.webp', { type: 'image/webp' });
    const input = { files: [file], value: 'member.webp' } as unknown as HTMLInputElement;

    try {
      await component.onQRImageSelected({ target: input } as unknown as Event);

      expect(loadImage).toHaveBeenCalledWith('blob:member-qr');
      expect(decodeImage).toHaveBeenCalledOnce();
      expect(attendanceService.checkInWithQR).toHaveBeenCalledWith('existing-member-qr-payload');
      expect(component.successMessage).toContain('Attendance marked successfully');
      expect(component.qrScannerOpen).toBe(false);
    } finally {
      loadImage.mockRestore();
      decodeImage.mockRestore();
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectURL
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectURL
      });
    }
  });

  it('shows the no-QR message on decode failure and allows selecting another image', async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn().mockReturnValue('blob:member-qr')
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn()
    });
    vi.spyOn(component as any, 'loadQRImage').mockResolvedValue({} as HTMLImageElement);
    const decodeImage = vi.spyOn(component as any, 'decodeQRImage')
      .mockRejectedValueOnce(new Error('No barcode found'))
      .mockResolvedValueOnce('valid-member-payload');
    attendanceService.checkInWithQR.mockReturnValue(of({
      message: 'Attendance marked successfully',
      member: { fullName: 'Test Member' }
    }));
    component.qrScannerOpen = true;
    const selectFile = async () => {
      const file = new File(['image'], 'member.png', { type: 'image/png' });
      const input = { files: [file], value: 'member.png' } as unknown as HTMLInputElement;
      await component.onQRImageSelected({ target: input } as unknown as Event);
    };

    try {
      await selectFile();
      expect(component.errorMessage)
        .toBe('No valid member QR code found. Please select another image.');
      expect(attendanceService.checkInWithQR).not.toHaveBeenCalled();

      await selectFile();
      expect(decodeImage).toHaveBeenCalledTimes(2);
      expect(attendanceService.checkInWithQR).toHaveBeenCalledWith('valid-member-payload');
    } finally {
      vi.restoreAllMocks();
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectURL
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectURL
      });
    }
  });

  it('exports every attendance record for the selected date, including QR source labels', async () => {
    const records = [
      {
        memberId: { _id: 'member-1', fullName: 'Alex Member', phone: '1111111111' },
        attendanceDate: '2026-10-12T00:00:00.000Z',
        checkIn: '2026-10-12T08:30:00.000Z',
        checkOut: '2026-10-12T10:00:00.000Z',
        attendanceType: 'Manual',
        status: 'Present'
      },
      {
        memberId: { _id: 'member-2', fullName: 'Sam Member', phone: '2222222222' },
        attendanceDate: '2026-10-12T00:00:00.000Z',
        checkIn: '2026-10-12T09:00:00.000Z',
        checkOut: null,
        attendanceType: 'QR',
        status: 'Present'
      }
    ];
    component.selectedDate = '2026-10-12';
    component.attendanceList = [records[0]];
    attendanceService.getDailyAttendance.mockReturnValue(of({ attendance: records }));
    const download = vi.spyOn(component as any, 'downloadBlob');

    component.exportCsv();

    expect(attendanceService.getDailyAttendance).toHaveBeenLastCalledWith('2026-10-12');
    expect(download).toHaveBeenCalledOnce();
    const csv = await (download.mock.calls[0][0] as Blob).text();
    expect(csv).toContain('"member-1"');
    expect(csv).toContain('"member-2"');
    expect(csv).toContain('"QR Code"');
    expect(csv).toContain('"Not Checked Out"');
  });
});
