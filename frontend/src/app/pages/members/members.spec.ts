import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';
import { SimpleChange } from '@angular/core';

import { Members } from './members';
import { MemberService } from '../../services/member';
import { MembershipPlanService } from '../../services/membership-plan';
import { PaymentService } from '../../services/payment';
import { DashboardService } from '../../services/dashboard';

describe('Members', () => {
  let component: Members;
  let fixture: ComponentFixture<Members>;
  let memberService: {
    getMembers: ReturnType<typeof vi.fn>;
    addMember: ReturnType<typeof vi.fn>;
    updateMember: ReturnType<typeof vi.fn>;
    generateMemberQR: ReturnType<typeof vi.fn>;
  };
  let planService: {
    getPlans: ReturnType<typeof vi.fn>;
    assignMembership: ReturnType<typeof vi.fn>;
    getMemberMemberships: ReturnType<typeof vi.fn>;
  };
  let paymentService: {
    getMemberPayments: ReturnType<typeof vi.fn>;
  };

  const member = {
    _id: 'member-123-b3d3bc',
    fullName: 'Test Member',
    phone: '1234567890',
    status: 'Active'
  };

  beforeEach(async () => {
    memberService = {
      getMembers: vi.fn().mockReturnValue(of({
        members: [],
        pagination: { totalMembers: 0, totalPages: 0 }
      })),
      addMember: vi.fn(),
      updateMember: vi.fn(),
      generateMemberQR: vi.fn()
    };
    planService = {
      getPlans: vi.fn().mockReturnValue(of({ plans: [] })),
      assignMembership: vi.fn(),
      getMemberMemberships: vi.fn()
    };
    paymentService = {
      getMemberPayments: vi.fn()
    };

    await TestBed.configureTestingModule({
      imports: [Members],
      providers: [
        { provide: MemberService, useValue: memberService },
        { provide: MembershipPlanService, useValue: planService },
        { provide: PaymentService, useValue: paymentService },
        { provide: DashboardService, useValue: { requestRefresh: vi.fn(), refreshRequested$: of() } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(Members);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('loads membership history once and reuses a recent result', () => {
    const records = [{ _id: 'membership-1', planPrice: 100 }];
    planService.getMemberMemberships.mockReturnValue(of({
      success: true,
      memberships: records
    }));

    component.openMembershipHistory(member);
    expect(component.membershipHistory).toEqual(records);
    expect(component.historyLoading).toBe(false);

    component.closeMembershipHistory();
    component.openMembershipHistory(member);

    expect(planService.getMemberMemberships).toHaveBeenCalledTimes(1);
    expect(component.membershipHistory).toEqual(records);
  });

  it('shows the same six-character member ID format as Dashboard Recent Members', () => {
    component.members = [member];
    fixture.detectChanges();

    const table = fixture.nativeElement.querySelector('.table-responsive table') as HTMLTableElement;
    const headers = Array.from(table.querySelectorAll('thead th'))
      .map(header => header.textContent?.trim());
    const row = table.querySelector('tbody tr') as HTMLTableRowElement;

    expect(headers.indexOf('MEMBER ID')).toBe(headers.indexOf('MEMBER') + 1);
    expect(row.cells[2].textContent?.trim()).toBe('B3D3BC');
  });

  it('submits enquiry conversion through the backend flow without creating a duplicate member', () => {
    const request = {
      requestId: 'enquiry-1-attempt',
      enquiryId: 'enquiry-1',
      enquiry: {
        fullName: 'Asha',
        phone: '9876543210',
        email: 'asha@example.com',
        gender: 'Female',
        age: 31
      }
    };
    const submitted = vi.fn();
    component.conversionSubmitted.subscribe(submitted);
    component.registrationRequest = request;
    component.ngOnChanges({
      registrationRequest: new SimpleChange(null, request, true)
    });

    expect(component.memberForm.fullName).toBe('Asha');
    expect(component.memberForm.phone).toBe('9876543210');
    expect(component.memberForm.email).toBe('asha@example.com');
    expect(component.memberForm.gender).toBe('Female');
    expect(component.memberForm.age).toBe(31);
    expect(component.memberForm.dateOfBirth).toBe('');

    component.saveMember();

    expect(memberService.addMember).not.toHaveBeenCalled();
    expect(submitted).toHaveBeenCalledWith(expect.objectContaining({
      requestId: request.requestId,
      enquiryId: request.enquiryId,
      payload: expect.objectContaining({ dateOfBirth: null, email: 'asha@example.com' })
    }));
    expect(submitted.mock.calls[0][0].payload).not.toHaveProperty('age');
  });

  it('debounces member search input and sends the latest term', async () => {
    component.search = 'ali';
    component.onSearchInput();
    component.search = 'alice';
    component.onSearchInput();

    await new Promise(resolve => setTimeout(resolve, 350));

    expect(memberService.getMembers).toHaveBeenCalledTimes(2);
    expect(memberService.getMembers).toHaveBeenLastCalledWith(
      'alice',
      '',
      1,
      10,
      undefined,
      undefined
    );
  });

  it('cancels outdated member requests so stale responses cannot replace current results', () => {
    const staleResponse = new Subject<any>();
    memberService.getMembers.mockReturnValueOnce(staleResponse);

    component.search = 'older';
    component.loadMembers();
    component.search = 'newer';
    component.loadMembers();
    staleResponse.next({
      members: [{ _id: 'stale-member' }],
      pagination: { totalMembers: 1, totalPages: 1 }
    });

    expect(component.members).toEqual([]);
    expect(memberService.getMembers).toHaveBeenCalledTimes(3);
  });

  it('shows an empty state for members without membership history', () => {
    planService.getMemberMemberships.mockReturnValue(of({
      success: true,
      memberships: []
    }));

    component.openMembershipHistory(member);

    expect(component.historyLoading).toBe(false);
    expect(component.historyError).toBe('');
    expect(component.membershipHistory).toEqual([]);
  });

  it('resets membership history loading and exposes API errors', () => {
    planService.getMemberMemberships.mockReturnValue(
      throwError(() => ({ error: { message: 'History request failed' } }))
    );

    component.openMembershipHistory(member);

    expect(component.historyLoading).toBe(false);
    expect(component.historyError).toBe('History request failed');
  });

  it('loads financial endpoints in parallel and caches the result briefly', () => {
    const payments = [{ _id: 'payment-1', amount: 25 }];
    const memberships = [
      { planPrice: 100, paidAmount: 25 },
      { planPrice: 50, paidAmount: 50 }
    ];
    paymentService.getMemberPayments.mockReturnValue(of({ payments }));
    planService.getMemberMemberships.mockReturnValue(of({ memberships }));

    component.openFinancialDetails(member);

    expect(component.financialLoading).toBe(false);
    expect(component.memberPayments).toEqual(payments);
    expect(component.totalPlanAmount).toBe(150);
    expect(component.totalPaidAmount).toBe(75);
    expect(component.totalDueAmount).toBe(75);

    component.closeFinancialDetails();
    component.openFinancialDetails(member);

    expect(paymentService.getMemberPayments).toHaveBeenCalledTimes(1);
    expect(planService.getMemberMemberships).toHaveBeenCalledTimes(1);
  });

  it('shows zero financial totals when the member has no records', () => {
    paymentService.getMemberPayments.mockReturnValue(of({ payments: [] }));
    planService.getMemberMemberships.mockReturnValue(of({ memberships: [] }));

    component.openFinancialDetails(member);

    expect(component.financialLoading).toBe(false);
    expect(component.financialError).toBe('');
    expect(component.memberPayments).toEqual([]);
    expect(component.totalPlanAmount).toBe(0);
    expect(component.totalPaidAmount).toBe(0);
    expect(component.totalDueAmount).toBe(0);
  });

  it('resets financial loading and shows an error when an API fails', () => {
    paymentService.getMemberPayments.mockReturnValue(
      throwError(() => ({ error: { message: 'Payments request failed' } }))
    );
    planService.getMemberMemberships.mockReturnValue(of({ memberships: [] }));

    component.openFinancialDetails(member);

    expect(component.financialLoading).toBe(false);
    expect(component.financialError).toBe('Payments request failed');
  });

  it('closes the member form and refreshes summaries after a successful save', () => {
    memberService.addMember.mockReturnValue(of({
      success: true,
      message: 'Member added'
    }));
    component.openAddForm();
    component.memberForm.fullName = 'New Member';
    component.memberForm.phone = '1234567890';

    component.saveMember();

    expect(component.saving).toBe(false);
    expect(component.showForm).toBe(false);
    expect(component.successMessage).toBe('Member added');
    expect(memberService.addMember).toHaveBeenCalledTimes(1);
  });

  it('keeps the form open after membership assignment failure and retries without recreating the member', () => {
    memberService.addMember.mockReturnValue(of({
      success: true,
      member: { _id: 'created-member' }
    }));
    planService.assignMembership
      .mockReturnValueOnce(throwError(() => ({
        error: { message: 'Assignment unavailable' }
      })))
      .mockReturnValueOnce(of({ success: true }));

    component.openAddForm();
    component.memberForm.fullName = 'New Member';
    component.memberForm.phone = '1234567890';
    component.memberForm.planId = 'plan-123';
    component.memberForm.membershipStartDate = '2026-11-06';

    component.saveMember();

    expect(component.saving).toBe(false);
    expect(component.showForm).toBe(true);
    expect(component.memberForm.fullName).toBe('New Member');
    expect(component.errorMessage).toContain('Assignment unavailable');

    component.saveMember();

    expect(memberService.addMember).toHaveBeenCalledTimes(1);
    expect(planService.assignMembership).toHaveBeenCalledTimes(2);
    expect(component.showForm).toBe(false);
  });

  it('generates and displays a QR image for the selected member', async () => {
    memberService.generateMemberQR.mockReturnValue(of({
      success: true,
      qrToken: 'opaque-random-member-token'
    }));

    component.generateQR(member);
    await vi.waitFor(() => {
      expect(component.qrLoading).toBe(false);
    });

    expect(memberService.generateMemberQR).toHaveBeenCalledWith(member._id);
    expect(component.showQRModal).toBe(true);
    expect(component.qrLoading).toBe(false);
    expect(component.qrImage).toMatch(/^data:image\/png;base64,/);
    expect(component.qrError).toBe('');
  });

  it('shows QR API errors and ends the loading state', () => {
    memberService.generateMemberQR.mockReturnValue(
      throwError(() => ({ error: { message: 'QR request failed' } }))
    );

    component.generateQR(member);

    expect(component.showQRModal).toBe(true);
    expect(component.qrLoading).toBe(false);
    expect(component.qrError).toBe('QR request failed');
  });
});
