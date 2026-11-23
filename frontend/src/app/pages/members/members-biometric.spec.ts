import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { DashboardService } from '../../services/dashboard';
import { MemberService } from '../../services/member';
import { MembershipPlanService } from '../../services/membership-plan';
import { PaymentService } from '../../services/payment';
import { CameraService } from '../../services/camera';
import { Members } from './members';

describe('Members face biometric actions', () => {
  let fixture: ComponentFixture<Members>;
  let memberService: {
    getMembers: ReturnType<typeof vi.fn>;
    getFaceStatus: ReturnType<typeof vi.fn>;
    getFaceDuplicateReport: ReturnType<typeof vi.fn>;
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
      })),
      getFaceDuplicateReport: vi.fn().mockReturnValue(of({
        success: true,
        status: 'REVIEW_REQUIRED',
        groups: [{ memberIds: ['member-a', 'member-b'], status: 'REVIEW_REQUIRED' }]
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

  it('makes the consent card clickable and gates face enrollment until consent is checked', () => {
    const component = fixture.componentInstance;
    component.showForm = true;
    component.isEditMode = true;
    component.selectedMemberId = member._id;
    component.memberForm.fullName = member.fullName;
    fixture.detectChanges();

    const checkbox = fixture.nativeElement.querySelector('.biometric-consent-input') as HTMLInputElement;
    const registerButton = fixture.nativeElement.querySelector('.face-enrollment-start') as HTMLButtonElement;
    expect(registerButton.disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Biometric Consent');
    expect(fixture.nativeElement.textContent).toContain(
      'I have verified this member and obtained informed consent to capture and store a secure face recognition template for gym attendance.'
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Camera frames are sent securely for temporary server-side processing and are not retained.'
    );

    fixture.nativeElement.querySelector('#face-consent-copy').click();
    expect(checkbox.checked).toBe(true);
    component.faceConsentGranted = checkbox.checked;
    fixture.detectChanges();

    expect(component.faceConsentGranted).toBe(true);
    expect(registerButton.disabled).toBe(false);
  });

  it('renders the constrained camera dialog and closes it through the camera-stop handler', () => {
    const component = fixture.componentInstance;
    component.showForm = true;
    component.isEditMode = true;
    component.selectedMemberId = member._id;
    component.memberForm.fullName = member.fullName;
    component.faceConsentGranted = true;
    component.faceCameraActive = true;
    fixture.detectChanges();

    const cameraService = TestBed.inject(CameraService);
    const stopCamera = vi.spyOn(cameraService, 'stop');
    const dialog = fixture.nativeElement.querySelector('.face-camera-dialog') as HTMLElement;
    const video = fixture.nativeElement.querySelector('.face-camera-preview video') as HTMLVideoElement;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Member ID: 507f1f77bcf86cd799439011');
    expect(fixture.nativeElement.textContent).toContain('Capture & Save');
    expect((fixture.nativeElement.querySelector('.face-camera-primary') as HTMLButtonElement).disabled).toBe(false);

    (fixture.nativeElement.querySelector('.face-camera-close') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(stopCamera).toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.face-camera-dialog')).toBeNull();
  });

  it('shows the admin duplicate audit report without exposing biometric templates', () => {
    const component = fixture.componentInstance;
    component.auditFaceDuplicates();
    fixture.detectChanges();

    expect(memberService.getFaceDuplicateReport).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.textContent).toContain(
      'Potential duplicate face identities require staff review.'
    );
    expect(fixture.nativeElement.textContent).toContain('member-a, member-b');
    expect(fixture.nativeElement.textContent).toContain(
      'Templates and attendance records are not changed by this audit.'
    );
  });

  it('maps a duplicate face rejection to the safe staff-facing message', () => {
    const component = fixture.componentInstance;
    const message = (component as any).getBiometricErrorMessage({
      error: { code: 'DUPLICATE_FACE_DETECTED', message: 'internal detail' },
      status: 409
    });

    expect(message).toBe(
      'This face is already registered with another member. Please contact gym staff.'
    );
    expect(message).not.toContain('internal detail');
  });
});
