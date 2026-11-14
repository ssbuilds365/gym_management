import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { TrainersStaff } from './trainers-staff';
import { ManagementService } from '../../services/management';

describe('TrainersStaff', () => {
  let fixture: ComponentFixture<TrainersStaff>;
  let component: TrainersStaff;
  let management: {
    getStaff: ReturnType<typeof vi.fn>;
    getTrainerFinancialPerformance: ReturnType<typeof vi.fn>;
    getTrainerStaffReport: ReturnType<typeof vi.fn>;
    createStaff: ReturnType<typeof vi.fn>;
    updateStaff: ReturnType<typeof vi.fn>;
    getTrainerAssignments: ReturnType<typeof vi.fn>;
    searchAssignableMembers: ReturnType<typeof vi.fn>;
    assignMemberToTrainer: ReturnType<typeof vi.fn>;
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
      getTrainerFinancialPerformance: vi.fn().mockReturnValue(of({
        success: true,
        summary: {
          gymMembershipExpected: 12000,
          gymMembershipCollected: 12000,
          gymMembershipPending: 0,
          ptExpected: 3000,
          ptCollected: 2000,
          ptPending: 1000
        },
        trainers: [{
          trainer: { _id: 'trainer-1', name: 'Alex Trainer', status: 'Active', specialization: 'Strength' },
          clients: { totalUniqueAssigned: 1, activeGymMembers: 1, activePTClients: 1 },
          gymMembership: { expected: 12000, collected: 12000, pending: 0, attribution: 'Primary trainer' },
          personalTraining: { expected: 3000, collected: 2000, pending: 1000 }
        }],
        limitations: []
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
      updateStaff: vi.fn().mockReturnValue(of({ success: true })),
      getTrainerAssignments: vi.fn().mockReturnValue(of({ members: [] })),
      searchAssignableMembers: vi.fn().mockReturnValue(of({
        members: [],
        pagination: { hasMore: false }
      })),
      assignMemberToTrainer: vi.fn().mockReturnValue(of({ success: true }))
    };

    await TestBed.configureTestingModule({
      imports: [TrainersStaff],
      providers: [
        { provide: ManagementService, useValue: management }
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

    expect(headings.indexOf('Trainers Management')).toBeLessThan(headings.indexOf('Staff Management'));
    expect(headings).toContain('Trainer Financial Performance');
  });

  it('uses the tenant-wide totals and active counts returned by the API', () => {
    expect(component.trainerTotal).toBe(3);
    expect(component.activeTrainerTotal).toBe(2);
    expect(component.staffTotal).toBe(4);
    expect(component.activeStaffTotal).toBe(3);
  });

  it('searches active assignment candidates on demand and displays the existing short member ID', () => {
    management.searchAssignableMembers.mockReturnValue(of({
      members: [{
        _id: 'member-1',
        fullName: 'Santosh',
        memberId: 'B3D3BC',
        phone: '9833788644'
      }],
      pagination: { hasMore: false }
    }));

    component.openAssignmentMemberSearch();
    fixture.detectChanges();

    expect(management.searchAssignableMembers).toHaveBeenCalledWith('', 1, 20);
    expect(component.availableMembers[0].memberId).toBe('B3D3BC');
    component.selectAssignmentMember(component.availableMembers[0]);
    expect(component.selectedMemberId).toBe('member-1');
    expect(component.selectedAssignmentMember?.memberId).toBe('B3D3BC');
    expect(component.assignmentMemberSearchOpen).toBe(false);
  });

  it('debounces assignment member search and loads the next result page on scroll', async () => {
    management.searchAssignableMembers
      .mockReturnValueOnce(of({
        members: [],
        pagination: { hasMore: true }
      }))
      .mockReturnValueOnce(of({
        members: [{
          _id: 'member-1',
          fullName: 'Santosh',
          memberId: 'B3D3BC',
          phone: '9833788644'
        }],
        pagination: { hasMore: true }
      }))
      .mockReturnValueOnce(of({
        members: [{
          _id: 'member-2',
          fullName: 'Praveen',
          memberId: 'B3D3AE',
          phone: '8767236521'
        }],
        pagination: { hasMore: false }
      }));

    component.openAssignmentMemberSearch();
    component.onAssignmentMemberSearch('983');
    component.onAssignmentMemberSearch('9833');
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(management.searchAssignableMembers).toHaveBeenCalledTimes(2);
    expect(management.searchAssignableMembers).toHaveBeenLastCalledWith('9833', 1, 20);
    component.loadMoreAssignableMembers({
      target: { scrollTop: 90, clientHeight: 100, scrollHeight: 200 }
    } as unknown as Event);

    expect(management.searchAssignableMembers).toHaveBeenLastCalledWith('9833', 2, 20);
    expect(component.availableMembers.map(member => member.fullName))
      .toEqual(['Santosh', 'Praveen']);
  });

  it('keeps the existing assignment role and training type when selecting a searchable result', () => {
    component.assignmentRole = 'Additional';
    component.assignmentTrainingType = 'Personal Training';
    component.selectAssignmentMember({
      _id: 'member-2',
      fullName: 'Praveen',
      memberId: 'B3D3AE',
      phone: '8767236521'
    });

    expect(component.assignmentRole).toBe('Additional');
    expect(component.assignmentTrainingType).toBe('Personal Training');
  });

  it('submits the selected member through the existing trainer assignment API', () => {
    component.assignmentTrainer = {
      _id: 'trainer-1',
      name: 'Alex Trainer',
      phone: '',
      email: '',
      role: 'Trainer',
      status: 'Active'
    };
    component.selectAssignmentMember({
      _id: 'member-3',
      fullName: 'Aditi',
      memberId: 'B3D3AC',
      phone: '9930364525'
    });

    component.assignMember();

    expect(management.assignMemberToTrainer).toHaveBeenCalledWith(
      'trainer-1',
      'member-3',
      'Primary',
      'General',
      false
    );
    expect(component.selectedMemberId).toBe('');
  });

  it('shows PT financial figures without gym membership attribution', () => {
    expect(component.financialTrainers[0].personalTraining.collected).toBe(2000);
    expect(fixture.nativeElement.textContent).not.toContain('Gym Membership');
    expect(fixture.nativeElement.textContent).not.toContain('Membership Expected');
    expect(fixture.nativeElement.textContent).not.toContain('Membership Collected');
    expect(fixture.nativeElement.textContent).not.toContain('Membership Pending');
    expect(fixture.nativeElement.textContent).not.toContain('Active Gym Members');
    expect(fixture.nativeElement.textContent).toContain('Personal Training · package ledger');
    expect(fixture.nativeElement.textContent).toContain('PT Expected');
    expect(fixture.nativeElement.textContent).toContain('PT Collected');
    expect(fixture.nativeElement.textContent).toContain('PT Pending');
    expect(management.getTrainerFinancialPerformance).toHaveBeenCalled();
  });

  it('refreshes trainer financial performance when the retained module becomes active again', () => {
    const callsBeforeActivation = management.getTrainerFinancialPerformance.mock.calls.length;
    fixture.componentRef.setInput('active', false);
    fixture.detectChanges();
    fixture.componentRef.setInput('active', true);
    fixture.detectChanges();

    expect(management.getTrainerFinancialPerformance).toHaveBeenCalledTimes(callsBeforeActivation + 1);
  });

  it('derives transaction and package payment badges independently', () => {
    const payment = {
      _id: 'payment-1',
      amount: 5000,
      refundedAmount: 0,
      netCollectedAmount: 5000,
      paymentMethod: 'Cash',
      paymentDate: '2026-11-09',
      transactionReference: '',
      status: 'Success'
    };

    expect(component.ptTransactionStatus(payment)).toBe('PAID');
    expect(component.ptPackagePaymentStatus('Partial')).toBe('PARTIAL PAID');
    expect(component.ptPackagePaymentStatus('Paid')).toBe('PAID');
    expect(component.ptTransactionStatus({ ...payment, refundedAmount: 2000, netCollectedAmount: 3000 }))
      .toBe('PARTIALLY REFUNDED');
    expect(component.ptTransactionStatus({ ...payment, refundedAmount: 5000, netCollectedAmount: 0 }))
      .toBe('REFUNDED');
    expect(component.ptTransactionStatus({ ...payment, status: 'Partial' })).toBe('PARTIAL PAID');
    expect(component.ptTransactionStatus({ ...payment, status: 'Failed' })).toBe('FAILED');
    expect(component.ptTransactionStatus({ ...payment, status: 'Pending' })).toBe('PENDING');
  });

  it('shows transaction status badges and keeps refund controls in transaction details', () => {
    component.ptTrainer = {
      _id: 'trainer-1',
      name: 'Alex Trainer',
      phone: '',
      email: '',
      role: 'Trainer',
      status: 'Active'
    };
    const payment = {
      _id: 'payment-1',
      amount: 5000,
      refundedAmount: 0,
      netCollectedAmount: 5000,
      paymentMethod: 'Cash',
      paymentDate: '2026-11-09',
      transactionReference: '',
      status: 'Success'
    };
    component.ptPackages = [{
      _id: 'package-1',
      memberId: 'member-1',
      packageName: 'PT Monthly',
      packageType: 'Monthly',
      startDate: '2026-11-01',
      endDate: '2026-11-30',
      totalFee: 10000,
      collectedAmount: 5000,
      pendingAmount: 5000,
      paymentStatus: 'Partial',
      status: 'Active',
      payments: [payment]
    }];
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('PARTIAL PAID');
    expect(root.textContent).toContain('PAID');
    expect(root.querySelector('.pt-payment-row')?.textContent).not.toContain('Record completed refund');

    root.querySelector<HTMLButtonElement>('.pt-payment-row .secondary-btn')?.click();
    fixture.detectChanges();
    expect(root.querySelector('.pt-payment-details')?.textContent).toContain('Record completed refund');
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
