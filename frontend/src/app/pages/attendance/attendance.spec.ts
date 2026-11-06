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
