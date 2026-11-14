import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize, Subscription } from 'rxjs';
import { jsPDF } from 'jspdf';
import { ManagementService } from '../../services/management';

interface TeamRecord {
  _id: string;
  name: string;
  phone: string;
  email: string;
  role: 'Trainer' | 'Staff';
  specialization?: string;
  maxClientCapacity?: number | null;
  designation?: string;
  department?: string;
  joiningDate?: string;
  salaryAmount?: number | null;
  compensationType?: 'Salary' | 'Commission';
  status: 'Active' | 'Inactive';
  assignedMemberCount?: number;
  assignedMembers?: Array<{ _id: string; fullName: string; phone: string }>;
}

interface TeamForm {
  name: string;
  phone: string;
  email: string;
  specialization: string;
  maxClientCapacity: number | null;
  designation: string;
  department: string;
  joiningDate: string;
  salaryAmount: number | null;
  compensationType: 'Salary' | 'Commission';
  status: 'Active' | 'Inactive';
}

interface TrainerFinancialRow {
  trainer: {
    _id: string;
    name: string;
    status: 'Active' | 'Inactive';
    specialization: string;
  };
  clients: {
    totalUniqueAssigned: number;
    activePTClients: number;
  };
  personalTraining: { expected: number; collected: number; pending: number };
}

interface TrainerPTPaymentRow {
  _id: string;
  amount: number;
  refundedAmount: number;
  netCollectedAmount: number;
  paymentMethod: string;
  paymentDate: string;
  transactionReference: string;
  status: string;
}

type TrainerPTTransactionStatus =
  | 'PAID'
  | 'PARTIAL PAID'
  | 'REFUNDED'
  | 'PARTIALLY REFUNDED'
  | 'FAILED'
  | 'PENDING';

interface TrainerPTPackageRow {
  _id: string;
  memberId: { _id: string; fullName: string; phone: string } | string;
  packageName: string;
  packageType: string;
  startDate: string;
  endDate: string;
  totalFee: number;
  collectedAmount: number;
  pendingAmount: number;
  paymentStatus: string;
  status: string;
  payments: TrainerPTPaymentRow[];
}

const todayString = (): string => {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
};

@Component({
  selector: 'app-trainers-staff',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './trainers-staff.html',
  styleUrl: './trainers-staff.scss'
})
export class TrainersStaff implements OnInit, OnChanges, OnDestroy {
  @Input() active = false;
  trainers: TeamRecord[] = [];
  staff: TeamRecord[] = [];
  trainerTotal = 0;
  staffTotal = 0;
  trainerMatchTotal = 0;
  staffMatchTotal = 0;
  activeTrainerTotal = 0;
  activeStaffTotal = 0;
  financialLoading = false;
  financialError = '';
  financialSummary: Record<string, number> | null = null;
  financialTrainers: TrainerFinancialRow[] = [];
  financialLimitations: string[] = [];
  ptDetailsPaymentId = '';
  trainerPage = 1;
  staffPage = 1;
  readonly pageSize = 10;
  trainerPages = 0;
  staffPages = 0;
  trainerSearch = '';
  staffSearch = '';
  trainerStatus = '';
  staffStatus = '';
  loading = false;
  savingRole: 'Trainer' | 'Staff' | '' = '';
  errorMessage = '';
  successMessage = '';
  showTrainerForm = false;
  showStaffForm = false;
  editingTrainerId = '';
  editingStaffId = '';
  trainerForm = this.emptyForm();
  staffForm = this.emptyForm();
  selectedRecord: TeamRecord | null = null;
  assignmentTrainer: TeamRecord | null = null;
  assignedMembers: Array<{
    _id: string;
    fullName: string;
    phone: string;
    email?: string;
    status: string;
    assignmentRole?: 'Primary' | 'Additional';
  }> = [];
  availableMembers: Array<{
    _id: string;
    fullName: string;
    phone: string;
    memberId: string;
  }> = [];
  selectedMemberId = '';
  selectedAssignmentMember: { _id: string; fullName: string; phone: string; memberId: string } | null = null;
  assignmentMemberSearchOpen = false;
  assignmentMemberSearch = '';
  assignmentMemberLoading = false;
  assignmentMemberHasMore = false;
  assignmentMemberError = '';
  assignmentMemberActiveIndex = 0;
  private assignmentMemberPage = 1;
  private assignmentMemberSearchTimer?: ReturnType<typeof setTimeout>;
  private assignmentMemberRequest?: Subscription;
  assignmentRole: 'Primary' | 'Additional' = 'Primary';
  assignmentTrainingType: 'General' | 'Personal Training' = 'General';
  ptTrainer: TeamRecord | null = null;
  ptPackages: TrainerPTPackageRow[] = [];
  ptPackagesLoading = false;
  ptSaving = false;
  ptError = '';
  ptSuccess = '';
  ptPackageForm = this.emptyPTPackageForm();
  ptPaymentPackageId = '';
  ptPaymentForm = this.emptyPTPaymentForm();
  private ptPaymentRequestFingerprint = '';
  ptRefundPaymentId = '';
  ptRefundForm = this.emptyPTRefundForm();
  assignmentLoading = false;
  assigning = false;
  reportLoading = false;
  reportError = '';
  reportRecords: TeamRecord[] = [];
  staffByDesignation: Array<{
    designation: string;
    department: string;
    total: number;
    active: number;
    inactive: number;
  }> = [];
  reportRole = '';
  reportStatus = '';
  reportPeriod = 'thisMonth';
  reportFrom = todayString().slice(0, 7) + '-01';
  reportTo = todayString();
  reportAppliedFrom = '';
  reportAppliedTo = '';
  reportCapabilities = {
    trainerAttendance: false,
    staffAttendance: false,
    batchAssignments: false,
    salaryTransactions: false
  };
  private readonly businessName = this.readBusinessName();
  private trainerRequest?: Subscription;
  private staffRequest?: Subscription;
  private financialRequest?: Subscription;
  private ptPackageRequest?: Subscription;
  private trainerSearchTimer?: ReturnType<typeof setTimeout>;
  private staffSearchTimer?: ReturnType<typeof setTimeout>;
  private pendingDirectoryRequests = 0;

  constructor(
    private readonly management: ManagementService,
    private readonly changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.load();
    this.loadReport();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['active'] && !changes['active'].firstChange && this.active) {
      this.loadFinancialPerformance();
      if (this.ptTrainer) this.loadPTPackages();
    }
  }

  ngOnDestroy(): void {
    this.clearSearchTimer('Trainer');
    this.clearSearchTimer('Staff');
    this.clearAssignmentMemberSearch();
    this.trainerRequest?.unsubscribe();
    this.staffRequest?.unsubscribe();
    this.financialRequest?.unsubscribe();
    this.ptPackageRequest?.unsubscribe();
  }

  private emptyForm(): TeamForm {
    return {
      name: '',
      phone: '',
      email: '',
      specialization: '',
      maxClientCapacity: null,
      designation: '',
      department: '',
      joiningDate: todayString(),
      salaryAmount: null,
      compensationType: 'Salary',
      status: 'Active'
    };
  }

  load(): void {
    this.errorMessage = '';
    this.loadDirectory('Trainer');
    this.loadDirectory('Staff');
    this.loadFinancialPerformance();
  }

  loadFinancialPerformance(): void {
    this.financialRequest?.unsubscribe();
    this.financialLoading = true;
    this.financialError = '';
    this.financialRequest = this.management.getTrainerFinancialPerformance()
      .pipe(finalize(() => {
        this.financialLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          if (!response?.success) {
            this.financialError = 'Unable to load trainer financial performance.';
            this.financialSummary = null;
            this.financialTrainers = [];
            return;
          }
          this.financialSummary = response.summary || null;
          this.financialTrainers = response.trainers || [];
          this.financialLimitations = (response.limitations || [])
            .filter((limitation: string) => !/membership attribution/i.test(limitation));
        },
        error: error => {
          console.error('Trainer financial performance loading error:', error);
          this.financialError = error.error?.message || 'Unable to load trainer financial performance.';
          this.financialSummary = null;
          this.financialTrainers = [];
        }
      });
  }

  formatCurrency(amount: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 2
    }).format(Number(amount) || 0);
  }

  ptMemberName(ptPackage: TrainerPTPackageRow): string {
    return typeof ptPackage.memberId === 'string'
      ? 'Member'
      : ptPackage.memberId.fullName || 'Member';
  }

  ptTransactionStatus(payment: TrainerPTPaymentRow): TrainerPTTransactionStatus {
    if (payment.status === 'Failed') return 'FAILED';
    if (payment.status === 'Pending') return 'PENDING';
    if (payment.status === 'Partial' || payment.status === 'Partially Paid') return 'PARTIAL PAID';

    const refunded = Number(payment.refundedAmount) || 0;
    if (refunded > 0) {
      return Number(payment.netCollectedAmount) > 0
        ? 'PARTIALLY REFUNDED'
        : 'REFUNDED';
    }
    return payment.status === 'Success' ? 'PAID' : 'PENDING';
  }

  ptTransactionStatusClass(payment: TrainerPTPaymentRow): string {
    switch (this.ptTransactionStatus(payment)) {
      case 'PAID':
        return 'paid';
      case 'PARTIAL PAID':
        return 'partial';
      case 'REFUNDED':
      case 'PARTIALLY REFUNDED':
        return 'refunded';
      case 'FAILED':
        return 'failed';
      default:
        return 'pending';
    }
  }

  ptPackagePaymentStatus(status: string): 'PAID' | 'PARTIAL PAID' | 'PENDING' {
    if (status === 'Paid') return 'PAID';
    if (status === 'Partial') return 'PARTIAL PAID';
    return 'PENDING';
  }

  ptPackagePaymentStatusClass(status: string): string {
    if (status === 'Paid') return 'paid';
    if (status === 'Partial') return 'partial';
    return 'pending';
  }

  togglePTPaymentDetails(payment: TrainerPTPaymentRow): void {
    this.ptDetailsPaymentId = this.ptDetailsPaymentId === payment._id ? '' : payment._id;
  }

  private emptyPTPackageForm(): {
    memberId: string;
    packageName: string;
    packageType: string;
    startDate: string;
    endDate: string;
    totalFee: number | null;
    paymentFrequency: string;
  } {
    const today = todayString();
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    return {
      memberId: '',
      packageName: '',
      packageType: 'Monthly',
      startDate: today,
      endDate: `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-${String(nextMonth.getDate()).padStart(2, '0')}`,
      totalFee: null,
      paymentFrequency: 'Monthly'
    };
  }

  private emptyPTPaymentForm(): {
    amount: number | null;
    paymentMethod: string;
    transactionReference: string;
    paymentDate: string;
    notes: string;
    requestId: string;
  } {
    return {
      amount: null,
      paymentMethod: 'Cash',
      transactionReference: '',
      paymentDate: todayString(),
      notes: '',
      requestId: ''
    };
  }

  private emptyPTRefundForm(): { amount: number | null; refundReference: string; reason: string } {
    return { amount: null, refundReference: '', reason: '' };
  }

  private loadDirectory(role: 'Trainer' | 'Staff'): void {
    this.clearSearchTimer(role);
    this.cancelDirectoryRequest(role);
    this.pendingDirectoryRequests++;
    this.loading = true;
    const isTrainer = role === 'Trainer';
    const page = isTrainer ? this.trainerPage : this.staffPage;
    const status = isTrainer ? this.trainerStatus : this.staffStatus;
    const search = isTrainer ? this.trainerSearch : this.staffSearch;
    const request = this.management.getStaff({ role, status, search, page, limit: this.pageSize })
      .pipe(finalize(() => {
        this.pendingDirectoryRequests = Math.max(0, this.pendingDirectoryRequests - 1);
        this.loading = this.pendingDirectoryRequests > 0;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          if (isTrainer) {
            this.trainers = response.staff || [];
            this.trainerMatchTotal = response.total || 0;
            this.trainerPages = response.totalPages || 0;
          } else {
            this.staff = response.staff || [];
            this.staffMatchTotal = response.total || 0;
            this.staffPages = response.totalPages || 0;
          }
          this.trainerTotal = response.summary?.trainers?.total || 0;
          this.staffTotal = response.summary?.staff?.total || 0;
          this.activeTrainerTotal = response.summary?.trainers?.active || 0;
          this.activeStaffTotal = response.summary?.staff?.active || 0;
        },
        error: error => {
          console.error(`${role} directory loading error:`, error);
          this.errorMessage = error.error?.message || `Unable to load ${role.toLowerCase()} records.`;
        }
      });
    if (isTrainer) this.trainerRequest = request;
    else this.staffRequest = request;
  }

  onDirectorySearchInput(role: 'Trainer' | 'Staff'): void {
    this.clearSearchTimer(role);
    this.cancelDirectoryRequest(role);
    const timer = setTimeout(() => {
      if (role === 'Trainer') this.trainerSearchTimer = undefined;
      else this.staffSearchTimer = undefined;
      this.searchDirectory(role);
    }, 300);
    if (role === 'Trainer') this.trainerSearchTimer = timer;
    else this.staffSearchTimer = timer;
  }

  private clearSearchTimer(role: 'Trainer' | 'Staff'): void {
    const timer = role === 'Trainer' ? this.trainerSearchTimer : this.staffSearchTimer;
    if (timer) clearTimeout(timer);
    if (role === 'Trainer') this.trainerSearchTimer = undefined;
    else this.staffSearchTimer = undefined;
  }

  private cancelDirectoryRequest(role: 'Trainer' | 'Staff'): void {
    if (role === 'Trainer') {
      this.trainerRequest?.unsubscribe();
      this.trainerRequest = undefined;
    } else {
      this.staffRequest?.unsubscribe();
      this.staffRequest = undefined;
    }
  }

  searchDirectory(role: 'Trainer' | 'Staff'): void {
    this.clearSearchTimer(role);
    if (role === 'Trainer') this.trainerPage = 1;
    else this.staffPage = 1;
    this.loadDirectory(role);
  }

  changePage(role: 'Trainer' | 'Staff', delta: number): void {
    this.clearSearchTimer(role);
    if (role === 'Trainer') {
      this.trainerPage = Math.max(1, Math.min(this.trainerPages, this.trainerPage + delta));
    } else {
      this.staffPage = Math.max(1, Math.min(this.staffPages, this.staffPage + delta));
    }
    this.loadDirectory(role);
  }

  toggleForm(role: 'Trainer' | 'Staff'): void {
    if (role === 'Trainer') {
      this.showTrainerForm = !this.showTrainerForm;
      if (!this.showTrainerForm) this.cancelEdit(role);
    } else {
      this.showStaffForm = !this.showStaffForm;
      if (!this.showStaffForm) this.cancelEdit(role);
    }
    this.errorMessage = '';
  }

  edit(record: TeamRecord): void {
    const form: TeamForm = {
      name: record.name,
      phone: record.phone,
      email: record.email || '',
      specialization: record.specialization || '',
      maxClientCapacity: record.maxClientCapacity ?? null,
      designation: record.designation || '',
      department: record.department || '',
      joiningDate: record.joiningDate ? String(record.joiningDate).slice(0, 10) : '',
      salaryAmount: record.salaryAmount ?? null,
      compensationType: record.compensationType || 'Salary',
      status: record.status
    };
    if (record.role === 'Trainer') {
      this.editingTrainerId = record._id;
      this.trainerForm = form;
      this.showTrainerForm = true;
    } else {
      this.editingStaffId = record._id;
      this.staffForm = form;
      this.showStaffForm = true;
    }
    this.selectedRecord = null;
    this.successMessage = '';
    this.errorMessage = '';
  }

  cancelEdit(role: 'Trainer' | 'Staff'): void {
    if (role === 'Trainer') {
      this.editingTrainerId = '';
      this.trainerForm = this.emptyForm();
    } else {
      this.editingStaffId = '';
      this.staffForm = this.emptyForm();
    }
  }

  save(role: 'Trainer' | 'Staff'): void {
    if (this.savingRole) return;
    this.savingRole = role;
    this.errorMessage = '';
    this.successMessage = '';
    const editingId = role === 'Trainer' ? this.editingTrainerId : this.editingStaffId;
    const form = role === 'Trainer' ? this.trainerForm : this.staffForm;
    const record = {
      ...form,
      role,
      specialization: role === 'Trainer' ? form.specialization : '',
      designation: role === 'Staff' ? form.designation : '',
      department: role === 'Staff' ? form.department : '',
      compensationType: role === 'Trainer' ? form.compensationType : 'Salary'
    };
    const request = editingId
      ? this.management.updateStaff(editingId, record)
      : this.management.createStaff(record);
    request.pipe(finalize(() => {
      this.savingRole = '';
      this.changeDetector.markForCheck();
    })).subscribe({
      next: () => {
        this.successMessage = editingId ? `${role} updated.` : `${role} added.`;
        this.cancelEdit(role);
        if (role === 'Trainer') this.showTrainerForm = false;
        else this.showStaffForm = false;
        this.load();
        this.loadReport();
      },
      error: error => {
        console.error(`${role} save error:`, error);
        this.errorMessage = error.error?.message || `Unable to save ${role.toLowerCase()}.`;
      }
    });
  }

  view(record: TeamRecord): void {
    this.selectedRecord = record;
  }

  setStatus(record: TeamRecord, status: 'Active' | 'Inactive'): void {
    if (status === 'Inactive' && !confirm(`Deactivate ${record.name}?`)) return;
    this.errorMessage = '';
    this.management.updateStaff(record._id, { status })
      .pipe(finalize(() => this.changeDetector.markForCheck()))
      .subscribe({
      next: () => {
        this.successMessage = `${record.role} ${status === 'Inactive' ? 'deactivated' : 'activated'}.`;
        this.selectedRecord = null;
        this.load();
        this.loadReport();
      },
      error: error => {
        console.error(`${record.role} status update error:`, error);
        this.errorMessage = error.error?.message || `Unable to update ${record.role.toLowerCase()} status.`;
      }
    });
  }

  openAssignments(trainer: TeamRecord): void {
    this.clearAssignmentMemberSearch();
    this.assignmentTrainer = trainer;
    this.assignmentLoading = true;
    this.assignmentMemberSearchOpen = false;
    this.assignmentMemberSearch = '';
    this.assignmentMemberError = '';
    this.assignmentMemberHasMore = false;
    this.availableMembers = [];
    this.selectedMemberId = '';
    this.selectedAssignmentMember = null;
    this.errorMessage = '';
    this.management.getTrainerAssignments(trainer._id)
      .pipe(finalize(() => {
        this.assignmentLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => this.assignedMembers = response.members || [],
        error: error => {
          console.error('Trainer assignment loading error:', error);
          this.errorMessage = error.error?.message || 'Unable to load trainer assignments.';
          this.assignmentTrainer = null;
        }
      });
  }

  openAssignmentMemberSearch(): void {
    if (this.assignmentMemberSearchOpen) {
      this.assignmentMemberSearchOpen = false;
      return;
    }
    this.assignmentMemberSearchOpen = true;
    this.assignmentMemberSearch = '';
    this.assignmentMemberError = '';
    this.assignmentMemberPage = 1;
    this.availableMembers = [];
    this.requestAssignableMembers(1, false);
  }

  onAssignmentMemberSearch(value: string): void {
    this.assignmentMemberSearch = value;
    this.assignmentMemberActiveIndex = 0;
    this.assignmentMemberPage = 1;
    this.assignmentMemberHasMore = false;
    this.availableMembers = [];
    this.assignmentMemberError = '';
    this.assignmentMemberRequest?.unsubscribe();
    if (this.assignmentMemberSearchTimer) clearTimeout(this.assignmentMemberSearchTimer);
    this.assignmentMemberSearchTimer = setTimeout(() => {
      this.assignmentMemberSearchTimer = undefined;
      this.requestAssignableMembers(1, false);
    }, 250);
  }

  private requestAssignableMembers(page: number, append: boolean): void {
    this.assignmentMemberRequest?.unsubscribe();
    this.assignmentMemberLoading = true;
    this.assignmentMemberError = '';
    this.assignmentMemberRequest = this.management
      .searchAssignableMembers(this.assignmentMemberSearch.trim(), page, 20)
      .pipe(finalize(() => {
        this.assignmentMemberLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          const members = response.members || [];
          this.availableMembers = append
            ? [...this.availableMembers, ...members]
            : members;
          this.assignmentMemberPage = page;
          this.assignmentMemberHasMore = Boolean(response.pagination?.hasMore);
          this.assignmentMemberActiveIndex = 0;
        },
        error: error => {
          console.error('Assignable member search error:', error);
          this.assignmentMemberError =
            error.error?.message || 'Unable to search active members. Please try again.';
        }
      });
  }

  loadMoreAssignableMembers(event: Event): void {
    const element = event.target as HTMLElement;
    if (
      element.scrollTop + element.clientHeight >= element.scrollHeight - 40 &&
      this.assignmentMemberHasMore &&
      !this.assignmentMemberLoading
    ) {
      this.requestAssignableMembers(this.assignmentMemberPage + 1, true);
    }
  }

  onAssignmentMemberKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.assignmentMemberSearchOpen = false;
      return;
    }
    if (event.key === 'ArrowDown' && this.availableMembers.length) {
      event.preventDefault();
      this.assignmentMemberActiveIndex =
        (this.assignmentMemberActiveIndex + 1) % this.availableMembers.length;
      return;
    }
    if (event.key === 'ArrowUp' && this.availableMembers.length) {
      event.preventDefault();
      this.assignmentMemberActiveIndex =
        (this.assignmentMemberActiveIndex - 1 + this.availableMembers.length) %
        this.availableMembers.length;
      return;
    }
    if (event.key === 'Enter' && this.availableMembers[this.assignmentMemberActiveIndex]) {
      event.preventDefault();
      this.selectAssignmentMember(this.availableMembers[this.assignmentMemberActiveIndex]);
    }
  }

  selectAssignmentMember(member: {
    _id: string;
    fullName: string;
    phone: string;
    memberId: string;
  }): void {
    this.selectedMemberId = member._id;
    this.selectedAssignmentMember = member;
    this.assignmentMemberSearchOpen = false;
    this.assignmentMemberError = '';
  }

  private clearAssignmentMemberSearch(): void {
    if (this.assignmentMemberSearchTimer) clearTimeout(this.assignmentMemberSearchTimer);
    this.assignmentMemberSearchTimer = undefined;
    this.assignmentMemberRequest?.unsubscribe();
  }

  assignMember(capacityOverrideConfirmed = false): void {
    if (!this.assignmentTrainer || !this.selectedMemberId || this.assigning) return;
    this.assigning = true;
    let retryWithCapacityOverride = false;
    this.management.assignMemberToTrainer(
      this.assignmentTrainer._id,
      this.selectedMemberId,
      this.assignmentRole,
      this.assignmentTrainingType,
      capacityOverrideConfirmed
    )
      .pipe(finalize(() => {
        this.assigning = false;
        this.changeDetector.markForCheck();
        if (retryWithCapacityOverride) this.assignMember(true);
      }))
      .subscribe({
        next: () => {
          this.selectedMemberId = '';
          this.selectedAssignmentMember = null;
          this.successMessage = 'Member assigned to trainer.';
          this.openAssignments(this.assignmentTrainer!);
          this.loadDirectory('Trainer');
          this.loadReport();
        },
        error: error => {
          console.error('Member assignment error:', error);
          if (
            error.error?.code === 'TRAINER_CAPACITY_EXCEEDED' &&
            !capacityOverrideConfirmed &&
            window.confirm(
              `${error.error.message}. This assignment exceeds the trainer's configured capacity. Override the limit?`
            )
          ) {
            retryWithCapacityOverride = true;
            return;
          }
          this.errorMessage = error.error?.message || 'Unable to assign member.';
        }
      });
  }

  removeAssignment(member: { _id: string; fullName: string }): void {
    if (!this.assignmentTrainer) return;
    this.management.removeTrainerAssignment(this.assignmentTrainer._id, member._id)
      .pipe(finalize(() => this.changeDetector.markForCheck()))
      .subscribe({
      next: () => {
        this.assignedMembers = this.assignedMembers.filter(item => item._id !== member._id);
        this.successMessage = `${member.fullName} removed from trainer.`;
        this.loadDirectory('Trainer');
        this.loadReport();
      },
      error: error => {
        console.error('Trainer assignment removal error:', error);
        this.errorMessage = error.error?.message || 'Unable to remove trainer assignment.';
      }
    });
  }

  closeAssignments(): void {
    this.clearAssignmentMemberSearch();
    this.assignmentTrainer = null;
    this.assignedMembers = [];
    this.selectedMemberId = '';
    this.selectedAssignmentMember = null;
    this.assignmentMemberSearchOpen = false;
    this.availableMembers = [];
  }

  openPTPackages(trainer: TeamRecord): void {
    this.ptTrainer = trainer;
    this.ptPackages = [];
    this.ptPackageForm = this.emptyPTPackageForm();
    this.ptError = '';
    this.ptSuccess = '';
    this.loadPTPackages();
  }

  loadPTPackages(): void {
    if (!this.ptTrainer) return;
    this.ptPackageRequest?.unsubscribe();
    this.ptPackagesLoading = true;
    this.ptError = '';
    const trainerId = this.ptTrainer._id;
    this.ptPackageRequest = this.management.getTrainerPTPackages(trainerId)
      .pipe(finalize(() => {
        this.ptPackagesLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          if (this.ptTrainer?._id === trainerId) this.ptPackages = response.packages || [];
        },
        error: error => {
          console.error('PT package loading error:', error);
          this.ptError = error.error?.message || 'Unable to load PT packages.';
        }
      });
  }

  createPTPackage(): void {
    if (!this.ptTrainer || this.ptSaving) return;
    this.ptSaving = true;
    this.ptError = '';
    this.ptSuccess = '';
    this.management.createTrainerPTPackage(this.ptTrainer._id, this.ptPackageForm)
      .pipe(finalize(() => {
        this.ptSaving = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: () => {
          this.ptSuccess = 'Personal training package created.';
          this.ptPackageForm = this.emptyPTPackageForm();
          this.loadPTPackages();
          this.loadFinancialPerformance();
        },
        error: error => {
          console.error('PT package creation error:', error);
          this.ptError = error.error?.message || 'Unable to create PT package.';
        }
      });
  }

  startPTPayment(ptPackage: TrainerPTPackageRow): void {
    this.ptPaymentPackageId = ptPackage._id;
    this.ptPaymentRequestFingerprint = '';
    this.ptPaymentForm = {
      ...this.emptyPTPaymentForm(),
      amount: ptPackage.pendingAmount
    };
  }

  recordPTPayment(): void {
    if (!this.ptPaymentPackageId || this.ptSaving) return;
    const { requestId: _requestId, ...payload } = this.ptPaymentForm;
    const fingerprint = JSON.stringify({ packageId: this.ptPaymentPackageId, ...payload });
    if (!this.ptPaymentForm.requestId || this.ptPaymentRequestFingerprint !== fingerprint) {
      this.ptPaymentForm.requestId = crypto.randomUUID();
      this.ptPaymentRequestFingerprint = fingerprint;
    }
    this.ptSaving = true;
    this.ptError = '';
    this.ptSuccess = '';
    this.management.recordTrainerPTPayment(this.ptPaymentPackageId, this.ptPaymentForm)
      .pipe(finalize(() => {
        this.ptSaving = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: () => {
          this.ptPaymentPackageId = '';
          this.ptPaymentRequestFingerprint = '';
          this.ptSuccess = 'PT payment recorded as successful.';
          this.loadPTPackages();
          this.loadFinancialPerformance();
        },
        error: error => {
          console.error('PT payment recording error:', error);
          this.ptError = error.error?.message || 'Unable to record PT payment.';
        }
      });
  }

  startPTRefund(payment: TrainerPTPaymentRow): void {
    this.ptRefundPaymentId = payment._id;
    this.ptRefundForm = {
      amount: payment.netCollectedAmount,
      refundReference: '',
      reason: ''
    };
  }

  recordPTRefund(): void {
    if (!this.ptRefundPaymentId || this.ptSaving) return;
    if (!confirm('Record a refund that has already been completed? This does not initiate a payment-provider refund.')) {
      return;
    }
    this.ptSaving = true;
    this.ptError = '';
    this.ptSuccess = '';
    this.management.refundTrainerPTPayment(this.ptRefundPaymentId, {
      ...this.ptRefundForm,
      confirmRefund: true
    }).pipe(finalize(() => {
      this.ptSaving = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: () => {
        this.ptRefundPaymentId = '';
        this.ptSuccess = 'Completed PT refund recorded.';
        this.loadPTPackages();
        this.loadFinancialPerformance();
      },
      error: error => {
        console.error('PT refund recording error:', error);
        this.ptError = error.error?.message || 'Unable to record PT refund.';
      }
    });
  }

  closePTPackages(): void {
    this.ptTrainer = null;
    this.ptPackages = [];
    this.ptPaymentPackageId = '';
    this.ptRefundPaymentId = '';
    this.ptPackageRequest?.unsubscribe();
  }

  setReportPeriod(period: string): void {
    this.reportPeriod = period;
    const today = new Date();
    const dateString = (date: Date): string =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (period === 'today') {
      this.reportFrom = this.reportTo = dateString(today);
    } else if (period === 'thisMonth') {
      this.reportFrom = dateString(new Date(today.getFullYear(), today.getMonth(), 1));
      this.reportTo = dateString(today);
    } else if (period === 'lastMonth') {
      this.reportFrom = dateString(new Date(today.getFullYear(), today.getMonth() - 1, 1));
      this.reportTo = dateString(new Date(today.getFullYear(), today.getMonth(), 0));
    }
  }

  loadReport(): void {
    if (!this.reportFrom || !this.reportTo || this.reportFrom > this.reportTo) {
      this.reportRecords = [];
      this.reportError = 'Choose a valid joining-date range with a start date before the end date.';
      return;
    }
    this.reportLoading = true;
    this.reportError = '';
    this.management.getTrainerStaffReport({
      role: this.reportRole,
      status: this.reportStatus,
      from: this.reportFrom,
      to: this.reportTo
    }).pipe(finalize(() => {
      this.reportLoading = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: response => {
        this.reportRecords = response.records || [];
        this.staffByDesignation = response.staffByDesignation || [];
        this.reportCapabilities = response.capabilities || this.reportCapabilities;
      },
      error: error => {
        console.error('Trainer/staff report loading error:', error);
        this.reportError = error.error?.message || 'Unable to load the report.';
      }
    });
  }

  exportReport(format: 'csv' | 'excel' | 'pdf' | 'print'): void {
    const columns = [
      'Type', 'Name', 'Phone', 'Email', 'Joining Date', 'Specialization',
      'Designation / Department', 'Assigned Member Count', 'Assigned Members', 'Status', 'Salary / Commission'
    ];
    const rows = this.reportRecords.map(record => [
      record.role,
      record.name,
      record.phone,
      record.email || '',
      this.displayDate(record.joiningDate),
      record.specialization || '',
      [record.designation, record.department].filter(Boolean).join(' / '),
      record.role === 'Trainer' ? String(record.assignedMemberCount || 0) : '',
      (record.assignedMembers || []).map(member => `${member.fullName} (${member.phone})`).join('; '),
      record.status,
      record.salaryAmount == null ? '' : `${record.compensationType || 'Salary'} ${record.salaryAmount}`
    ]);
    const title = 'Trainers & Staff Report';
    const generated = new Date().toLocaleString('en-IN');
    if (format === 'csv') {
      const csv = [columns, ...rows].map(row => row.map(value =>
        `"${String(value).replace(/"/g, '""')}"`
      ).join(',')).join('\r\n');
      this.download(`${title}.csv`, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
      return;
    }
    if (format === 'excel') {
      const html = `<html><head><meta charset="utf-8"></head><body><h2>${this.escapeHtml(this.businessName)}</h2><h3>${title}</h3><p>Generated: ${this.escapeHtml(generated)}</p><table border="1"><thead><tr>${columns.map(item => `<th>${this.escapeHtml(item)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(item => `<td>${this.escapeHtml(item)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
      this.download(`${title}.xls`, `\uFEFF${html}`, 'application/vnd.ms-excel;charset=utf-8');
      return;
    }
    if (format === 'pdf') {
      const pdf = new jsPDF({ orientation: 'landscape' });
      pdf.setFontSize(16);
      pdf.text(this.businessName, 14, 15);
      pdf.setFontSize(12);
      pdf.text(title, 14, 23);
      pdf.setFontSize(9);
      pdf.text(`Generated: ${generated}`, 14, 29);
      const pageWidth = pdf.internal.pageSize.getWidth();
      const widths = columns.map(() => (pageWidth - 28) / columns.length);
      pdf.setFontSize(6);
      let y = 37;
      const drawRow = (values: string[], bold = false): void => {
        const cells = values.map((value, index) =>
          pdf.splitTextToSize(value || '-', widths[index] - 3) as string[]
        );
        const rowHeight = Math.max(...cells.map(lines => lines.length)) * 3.2 + 3;
        if (y + rowHeight > pdf.internal.pageSize.getHeight() - 10) {
          pdf.addPage();
          y = 16;
        }
        pdf.setFont('helvetica', bold ? 'bold' : 'normal');
        let x = 14;
        cells.forEach((text, index) => {
          pdf.text(text, x + 1, y);
          x += widths[index];
        });
        y += rowHeight;
      };
      drawRow(columns, true);
      rows.forEach(row => drawRow(row));
      pdf.save(`${title}.pdf`);
      return;
    }
    const popup = window.open('', '_blank', 'width=1000,height=800');
    if (!popup) {
      this.errorMessage = 'Allow pop-ups to print the report.';
      return;
    }
    popup.document.open();
    popup.document.write(`<html><head><title>${title}</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#222}h2,h3{margin:4px 0}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:11px}th{background:#f2f3f5}@media print{button{display:none}}</style></head><body><h2>${this.escapeHtml(this.businessName)}</h2><h3>${title}</h3><p>Generated: ${this.escapeHtml(generated)}</p><table><thead><tr>${columns.map(item => `<th>${this.escapeHtml(item)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(item => `<td>${this.escapeHtml(item)}</td>`).join('')}</tr>`).join('')}</tbody></table><button onclick="window.print()">Print</button></body></html>`);
    popup.document.close();
  }

  private displayDate(value?: string): string {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-IN');
  }

  assignedMemberSummary(record: TeamRecord): string {
    return (record.assignedMembers || [])
      .map(member => `${member.fullName} (${member.phone})`)
      .join(', ') || '—';
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char] || char);
  }

  private download(filename: string, content: string, type: string): void {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private readBusinessName(): string {
    try {
      const business = JSON.parse(localStorage.getItem('business') || '{}');
      return business.businessName || 'SS Fitness Manager';
    } catch (error) {
      console.error('Business name could not be loaded for team report:', error);
      return 'SS Fitness Manager';
    }
  }
}
