import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { Payments } from './payments';
import { PaymentService } from '../../services/payment';
import { DashboardService } from '../../services/dashboard';

describe('Payments', () => {
  let component: Payments;
  let fixture: ComponentFixture<Payments>;
  let paymentService: {
    getEligibleMembers: ReturnType<typeof vi.fn>;
    getPayments: ReturnType<typeof vi.fn>;
    createPayment: ReturnType<typeof vi.fn>;
    recordPersonalTrainingPayment: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    paymentService = {
      getEligibleMembers: vi.fn().mockReturnValue(of({
        success: true,
        members: [{
          _id: 'member-1',
          fullName: 'Member 1',
          phone: '5551234',
          totalFee: 100,
          alreadyPaid: 40,
          pendingAmount: 60,
          memberships: [{
            _id: 'membership-1',
            planId: { planName: 'Monthly' },
            planPrice: 100,
            paidAmount: 40,
            pendingAmount: 60,
            status: 'Active'
          }]
        }]
      })),
      getPayments: vi.fn().mockReturnValue(of({
        payments: [],
        summary: {
          totalTransactions: 0,
          totalCollection: 0,
          pendingTransactions: 0,
          totalOutstanding: 0
        },
        pagination: { currentPage: 1, totalPayments: 0, totalPages: 0 }
      })),
      createPayment: vi.fn().mockReturnValue(of({ success: true })),
      recordPersonalTrainingPayment: vi.fn().mockReturnValue(of({ success: true }))
    };

    await TestBed.configureTestingModule({
      imports: [Payments],
      providers: [
        { provide: PaymentService, useValue: paymentService },
        { provide: DashboardService, useValue: { requestRefresh: vi.fn() } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(Payments);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates without dereferencing a missing membership GST snapshot', () => {
    component.openPaymentForm();
    expect(() => fixture.detectChanges()).not.toThrow();
    expect(component.selectedMembership).toBeNull();
  });

  it('loads eligible members from the backend for the selected category', () => {
    component.openPaymentForm();
    expect(paymentService.getEligibleMembers).toHaveBeenCalledWith('gym-membership');
    expect(component.members.map(member => member._id)).toEqual(['member-1']);
    expect(component.members[0].pendingAmount).toBe(60);
  });

  it('loads separate PT eligible packages after payment category changes', () => {
    paymentService.getEligibleMembers.mockReturnValueOnce(of({
      success: true,
      members: [{
        _id: 'pt-member',
        fullName: 'PT Member',
        phone: '5559876',
        totalFee: 500,
        alreadyPaid: 200,
        pendingAmount: 300,
        ptPackages: [{
          _id: 'pt-package',
          packageName: 'PT Monthly',
          totalFee: 500,
          alreadyPaid: 200,
          pendingAmount: 300
        }]
      }]
    }));

    component.showPaymentForm = true;
    component.paymentCategory = 'personal-training';
    component.onPaymentCategoryChange();
    component.selectedMemberId = 'pt-member';
    component.onMemberChange();
    component.selectedPTPackageId = 'pt-package';
    component.onPTPackageChange();

    expect(paymentService.getEligibleMembers).toHaveBeenCalledWith('personal-training');
    expect(component.selectedPTPackage?._id).toBe('pt-package');
    expect(component.pendingAmount).toBe(300);
  });

  it('uses the PT ledger rather than membership payment API for PT collections', () => {
    component.paymentCategory = 'personal-training';
    component.selectedMemberId = 'pt-member';
    component.selectedPTPackageId = 'pt-package';
    component.ptPackages = [{
      _id: 'pt-package',
      pendingAmount: 100
    }];
    component.paymentForm.amount = 100;

    component.submitPayment();

    expect(paymentService.recordPersonalTrainingPayment).toHaveBeenCalledWith(
      'pt-package',
      expect.objectContaining({ amount: 100, paymentMethod: 'Cash' })
    );
    expect(paymentService.createPayment).not.toHaveBeenCalled();
  });

  it('defaults the PT payment amount and enables collection for a valid package', () => {
    component.paymentCategory = 'personal-training';
    component.selectedMemberId = 'pt-member';
    component.ptPackages = [{
      _id: 'pt-package',
      pendingAmount: 6000
    }];
    component.selectedPTPackageId = 'pt-package';
    component.onPTPackageChange();
    component.openPaymentForm();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Payment Amount');
    const amountInput = fixture.nativeElement.querySelector('input[name="amount"]') as HTMLInputElement;
    const submitButton = fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement;

    expect(component.paymentForm.amount).toBe(6000);
    expect(amountInput).not.toBeNull();
    expect(submitButton.disabled).toBe(false);
  });

  it('blocks PT amounts above the outstanding balance', () => {
    component.paymentCategory = 'personal-training';
    component.selectedMemberId = 'pt-member';
    component.ptPackages = [{ _id: 'pt-package', pendingAmount: 2000 }];
    component.selectedPTPackageId = 'pt-package';
    component.paymentForm.amount = 2500;
    component.openPaymentForm();
    fixture.detectChanges();

    expect(component.canSubmitPayment).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('no more than the outstanding balance');
  });

  it('reuses the same PT request ID when retrying unchanged payment details', () => {
    component.paymentCategory = 'personal-training';
    component.selectedMemberId = 'pt-member';
    component.ptPackages = [{ _id: 'pt-package', pendingAmount: 6000 }];
    component.selectedPTPackageId = 'pt-package';
    component.paymentForm.amount = 3000;
    paymentService.recordPersonalTrainingPayment
      .mockReturnValueOnce(throwError(() => ({ error: { message: 'Temporary failure' } })))
      .mockReturnValueOnce(of({ success: true }));

    component.submitPayment();
    const firstRequestId = paymentService.recordPersonalTrainingPayment.mock.calls[0][1].requestId;
    component.submitPayment();

    expect(firstRequestId).toBeTruthy();
    expect(paymentService.recordPersonalTrainingPayment.mock.calls[1][1].requestId).toBe(firstRequestId);
  });
});
