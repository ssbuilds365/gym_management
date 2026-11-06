import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { TrainersStaff } from './trainers-staff';
import { ManagementService } from '../../services/management';
import { MemberService } from '../../services/member';

describe('TrainersStaff', () => {
  let fixture: ComponentFixture<TrainersStaff>;
  let component: TrainersStaff;
  let management: {
    getStaff: ReturnType<typeof vi.fn>;
    getTrainerStaffReport: ReturnType<typeof vi.fn>;
    createStaff: ReturnType<typeof vi.fn>;
    updateStaff: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    management = {
      getStaff: vi.fn().mockReturnValue(of({
        staff: [],
        total: 0,
        totalPages: 0,
        summary: {
          trainers: { total: 3, active: 2, inactive: 1 },
          staff: { total: 4, active: 3, inactive: 1 }
        }
      })),
      getTrainerStaffReport: vi.fn().mockReturnValue(of({
        records: [],
        capabilities: {
          trainerAttendance: false,
          staffAttendance: false,
          batchAssignments: false,
          salaryTransactions: false
        }
      })),
      createStaff: vi.fn().mockReturnValue(of({ success: true })),
      updateStaff: vi.fn().mockReturnValue(of({ success: true }))
    };

    await TestBed.configureTestingModule({
      imports: [TrainersStaff],
      providers: [
        { provide: ManagementService, useValue: management },
        { provide: MemberService, useValue: { getAllMatchingMembers: vi.fn().mockReturnValue(of([])) } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(TrainersStaff);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('shows separate trainer and staff sections in the requested order', () => {
    const root = fixture.nativeElement as HTMLElement;
    const headings = Array.from(root.querySelectorAll('.section-panel h3'))
      .map((heading: Element) => heading.textContent?.trim());

    expect(headings[0]).toBe('Trainers Management');
    expect(headings[1]).toBe('Staff Management');
  });

  it('uses the tenant-wide totals and active counts returned by the API', () => {
    expect(component.trainerTotal).toBe(3);
    expect(component.activeTrainerTotal).toBe(2);
    expect(component.staffTotal).toBe(4);
    expect(component.activeStaffTotal).toBe(3);
  });

  it('creates a trainer through the trainer form with its role set by the section', () => {
    component.trainerForm.name = 'Alex Trainer';
    component.trainerForm.phone = '1234567890';
    component.save('Trainer');

    expect(management.createStaff).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Alex Trainer', role: 'Trainer' })
    );
    expect(component.successMessage).toBe('Trainer added.');
  });

  it('debounces trainer search and requests the latest directory value', async () => {
    component.trainerSearch = 'al';
    component.onDirectorySearchInput('Trainer');
    component.trainerSearch = 'alex';
    component.onDirectorySearchInput('Trainer');

    await new Promise(resolve => setTimeout(resolve, 350));

    expect(management.getStaff).toHaveBeenCalledTimes(3);
    expect(management.getStaff).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: 'Trainer',
        search: 'alex',
        page: 1
      })
    );
  });
});
