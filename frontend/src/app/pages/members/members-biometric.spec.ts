import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { DashboardService } from '../../services/dashboard';
import { MemberService } from '../../services/member';
import { MembershipPlanService } from '../../services/membership-plan';
import { PaymentService } from '../../services/payment';
import { Members } from './members';

describe('Members face biometric actions', () => {
  let fixture: ComponentFixture<Members>;
  let memberService: {
    getMembers: ReturnType<typeof vi.fn>;
    getFaceStatus: ReturnType<typeof vi.fn>;
  };
  const member = {
    _id: '507f1f77bcf86cd799439011',
    fullName: 'Test Member',
    phone: '9999999999',
    gender: 'Other',
    joiningDate: '2026-01-01T00:00:00.000Z',
    status: 'Active'
  };

  beforeEach(async () => {
    memberService = {
      getMembers: vi.fn().mockReturnValue(of({
        members: [{ ...member }],
        pagination: { totalMembers: 1, totalPages: 1 }
      })),
      getFaceStatus: vi.fn().mockReturnValue(of({
        success: true,
        status: 'NotRegistered',
        registeredAt: null
      }))
    };
    await TestBed.configureTestingModule({
      imports: [Members],
      providers: [
        { provide: MemberService, useValue: memberService },
        { provide: MembershipPlanService, useValue: { getPlans: () => of([]) } },
        { provide: PaymentService, useValue: {} },
        { provide: DashboardService, useValue: {} }
      ]
    }).compileComponents();
    fixture = TestBed.createComponent(Members);
    fixture.detectChanges();
  });

  it('loads the status from the backend and offers registration for an unregistered member', () => {
    const component = fixture.componentInstance;

    expect(memberService.getFaceStatus).toHaveBeenCalledWith(member._id);
    expect(component.members[0].biometricStatus).toBe('NotRegistered');
    expect(fixture.nativeElement.textContent).toContain('Face Not Registered');
    expect(fixture.nativeElement.textContent).toContain('Register Face');
  });

  it('shows update and removal actions for a backend-registered member', () => {
    memberService.getFaceStatus.mockReturnValue(of({
      success: true,
      status: 'Registered',
      registeredAt: '2026-01-01T00:00:00.000Z'
    }));
    const component = fixture.componentInstance;
    component.loadFaceStatus(member._id);
    fixture.detectChanges();

    expect(component.members[0].biometricStatus).toBe('Registered');
    expect(fixture.nativeElement.textContent).toContain('Face Registered');
    expect(fixture.nativeElement.textContent).toContain('Update Face');
    expect(fixture.nativeElement.textContent).toContain('Remove Face');

    const updateButton = Array.from(fixture.nativeElement.querySelectorAll('button'))
      .find((button: any) => button.textContent.trim() === 'Update Face') as HTMLButtonElement;
    updateButton.click();
    fixture.detectChanges();

    expect(component.showForm).toBe(true);
    expect(component.selectedMemberId).toBe(member._id);
    expect(fixture.nativeElement.textContent).toContain('Member ID: 507f1f77bcf86cd799439011');
  });
});
