import {
  ChangeDetectorRef,
  Component,
  Input,
  OnDestroy,
  OnChanges,
  OnInit,
  SimpleChanges
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize, Subscription } from 'rxjs';
import { GlobalMessageService } from '../../services/global-message';
import {
  createWhatsAppUrl,
  GlobalMessageMember,
  personalizeGlobalMessage
} from '../../utils/global-message';

interface CampaignSummary {
  totalRecipients: number;
  whatsappOpened: number;
  manuallyMarkedSent: number;
  skipped: number;
  invalidNumber: number;
  pending: number;
}

@Component({
  selector: 'app-global-message',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './global-message.html',
  styleUrl: './global-message.scss'
})
export class GlobalMessage implements OnInit, OnChanges, OnDestroy {
  @Input() active = false;
  @Input() businessName = '';
  @Input() timeZone = 'Asia/Kolkata';

  readonly filters = [
    { value: 'all', label: 'All Members' },
    { value: 'active', label: 'Active Members' },
    { value: 'expired', label: 'Expired Members' },
    { value: 'expiringSoon', label: 'Expiring Soon' },
    { value: 'pendingFees', label: 'Pending Fees' },
    { value: 'custom', label: 'Custom Selection' }
  ];
  readonly variables = ['{{name}}', '{{gymName}}', '{{expiryDate}}', '{{pendingAmount}}', '{{planName}}'];

  members: GlobalMessageMember[] = [];
  selectedMembers = new Map<string, GlobalMessageMember>();
  selectedFilter = 'all';
  search = '';
  page = 1;
  totalPages = 0;
  totalEligible = 0;
  invalidNumberCount = 0;
  totalMembers = 0;
  loadingMembers = false;
  dashboardLoading = false;
  selectionLoading = false;
  savingCampaign = false;
  actionLoading = false;
  errorMessage = '';
  successMessage = '';

  campaignName = '';
  message = '';
  sampleMemberId = '';
  activeCampaign: any = null;
  currentRecipient: any = null;
  campaignSummary: CampaignSummary = this.emptySummary();
  history: any[] = [];
  historyPage = 1;
  historyTotalPages = 0;
  detailsCampaign: any = null;
  detailRecipients: any[] = [];
  detailSummary: CampaignSummary = this.emptySummary();
  detailPage = 1;
  detailTotalPages = 0;

  private initialized = false;
  private memberRequest?: Subscription;
  private searchTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly service: GlobalMessageService,
    private readonly changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.initialized = true;
    this.loadDashboard();
  }

  ngOnChanges(changes: SimpleChanges): void {
    const activeChange = changes['active'];
    if (activeChange?.currentValue && !activeChange.firstChange && this.initialized) {
      this.loadDashboard();
    }
  }

  ngOnDestroy(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.memberRequest?.unsubscribe();
  }

  get selectedCount(): number {
    return this.selectedMembers.size;
  }

  get previewMember(): GlobalMessageMember | null {
    return this.selectedMembers.get(this.sampleMemberId) ||
      this.selectedMembers.values().next().value ||
      null;
  }

  get previewMessage(): string {
    return this.previewMember
      ? this.personalizedMessage(this.previewMember)
      : this.message.replace(/\{\{\s*[a-zA-Z]+\s*\}\}/g, '');
  }

  get progressPercent(): number {
    if (!this.campaignSummary.totalRecipients) return 0;
    const processed = this.campaignSummary.manuallyMarkedSent +
      this.campaignSummary.skipped +
      this.campaignSummary.invalidNumber;
    return Math.round(processed / this.campaignSummary.totalRecipients * 100);
  }

  personalizedMessage(member: GlobalMessageMember): string {
    return personalizeGlobalMessage(this.message, member, this.gymName, this.timeZone);
  }

  get gymName(): string {
    if (this.businessName) return this.businessName;
    try {
      return JSON.parse(localStorage.getItem('business') || '{}').businessName || '';
    } catch {
      return '';
    }
  }

  loadDashboard(): void {
    if (this.dashboardLoading) return;
    this.dashboardLoading = true;
    this.errorMessage = '';
    this.service.summary().pipe(finalize(() => {
      this.dashboardLoading = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: response => {
        this.totalMembers = Number(response.totalMembers || 0);
        const active = response.activeCampaign;
        if (active) {
          this.loadCampaign(active._id);
        } else {
          this.activeCampaign = null;
          this.currentRecipient = null;
          this.campaignSummary = this.emptySummary();
        }
        this.loadHistory(1);
        this.loadMembers();
        this.changeDetector.markForCheck();
      },
      error: error => {
        this.errorMessage = error.error?.message || 'Unable to load Global Message data.';
        this.changeDetector.markForCheck();
      }
    });
  }

  loadMembers(): void {
    this.memberRequest?.unsubscribe();
    this.loadingMembers = true;
    this.memberRequest = this.service.members(this.selectedFilter, this.search.trim(), this.page, 50)
      .pipe(finalize(() => {
        this.loadingMembers = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          this.members = response.members || [];
          this.totalEligible = Number(response.pagination?.total || 0);
          this.totalPages = Number(response.pagination?.totalPages || 0);
          this.invalidNumberCount = Number(response.invalidNumberCount || 0);
          for (const member of this.members) {
            if (this.selectedMembers.has(member._id)) this.selectedMembers.set(member._id, member);
          }
        },
        error: error => {
          this.errorMessage = error.error?.message || 'Unable to load eligible members.';
        }
      });
  }

  onFilterChange(): void {
    this.page = 1;
    this.loadMembers();
  }

  onSearchChange(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page = 1;
      this.loadMembers();
    }, 250);
  }

  setPage(page: number): void {
    if (page < 1 || page > this.totalPages || this.loadingMembers) return;
    this.page = page;
    this.loadMembers();
  }

  isSelected(member: GlobalMessageMember): boolean {
    return this.selectedMembers.has(member._id);
  }

  toggleMember(member: GlobalMessageMember, checked: boolean): void {
    if (checked && this.selectedMembers.size >= 3000) {
      this.errorMessage = 'A campaign can include up to 3000 members. Remove a selected member before adding another.';
      return;
    }
    if (checked) this.selectedMembers.set(member._id, member);
    else this.selectedMembers.delete(member._id);
    if (!this.sampleMemberId || !this.selectedMembers.has(this.sampleMemberId)) {
      this.sampleMemberId = this.selectedMembers.keys().next().value || '';
    }
  }

  selectAllFiltered(): void {
    if (this.selectionLoading) return;
    this.selectionLoading = true;
    this.errorMessage = '';
    this.service.allMembers(this.selectedFilter, this.search.trim())
      .pipe(finalize(() => {
        this.selectionLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: allMembers => {
          const previousSelection = new Map(this.selectedMembers);
          const allSelected = allMembers.length > 0 &&
            allMembers.every(member => this.selectedMembers.has(member._id));
          if (allSelected) {
            allMembers.forEach(member => this.selectedMembers.delete(member._id));
          } else {
            allMembers.forEach(member => this.selectedMembers.set(member._id, member));
          }
          if (this.selectedMembers.size > 3000) {
            this.selectedMembers = previousSelection;
            this.errorMessage = 'A campaign can include up to 3000 members. Narrow your filters and select again.';
          }
          this.sampleMemberId = this.selectedMembers.keys().next().value || '';
        },
        error: error => {
          this.errorMessage = error.error?.message || 'Unable to select all filtered members.';
        }
      });
  }

  removeSelected(id: string): void {
    this.selectedMembers.delete(id);
    if (this.sampleMemberId === id) this.sampleMemberId = this.selectedMembers.keys().next().value || '';
  }

  addVariable(variable: string): void {
    this.message = `${this.message}${this.message && !this.message.endsWith(' ') ? ' ' : ''}${variable}`;
  }

  clearMessage(): void {
    this.message = '';
  }

  startCampaign(): void {
    if (!this.message.trim()) {
      this.errorMessage = 'Write a message before starting the campaign.';
      return;
    }
    if (!this.selectedMembers.size) {
      this.errorMessage = 'Select at least one member before starting the campaign.';
      return;
    }
    if (this.selectedMembers.size > 3000) {
      this.errorMessage = 'A campaign can include up to 3000 members.';
      return;
    }
    this.savingCampaign = true;
    this.errorMessage = '';
    this.successMessage = '';
    this.service.createCampaign({
      name: this.campaignName.trim(),
      message: this.message,
      memberIds: [...this.selectedMembers.keys()]
    }).subscribe({
      next: response => {
        const id = response.campaign?._id;
        this.service.updateCampaignStatus(id, 'IN_PROGRESS')
          .pipe(finalize(() => {
            this.savingCampaign = false;
            this.changeDetector.markForCheck();
          }))
          .subscribe({
            next: () => {
              this.successMessage = 'Campaign started. Open each WhatsApp chat and mark only manually sent messages as sent.';
              this.selectedMembers.clear();
              this.sampleMemberId = '';
              this.loadCampaign(id);
              this.loadHistory(1);
            },
            error: error => {
              this.errorMessage = error.error?.message || 'Campaign was saved as a draft but could not be started.';
              this.loadHistory(1);
            }
          });
      },
      error: error => {
        this.savingCampaign = false;
        this.errorMessage = error.error?.message || 'Unable to create campaign.';
        this.changeDetector.markForCheck();
      }
    });
  }

  loadCampaign(id: string): void {
    this.service.campaign(id).subscribe({
      next: response => {
        this.activeCampaign = response.campaign;
        this.campaignSummary = response.summary || this.emptySummary();
        this.currentRecipient = response.currentRecipient || null;
        this.changeDetector.markForCheck();
      },
      error: error => {
        this.errorMessage = error.error?.message || 'Unable to load campaign progress.';
        this.changeDetector.markForCheck();
      }
    });
  }

  loadHistory(page = 1): void {
    this.historyPage = page;
    this.service.campaigns(page).subscribe({
      next: response => {
        this.history = response.campaigns || [];
        this.historyTotalPages = Number(response.pagination?.totalPages || 0);
        this.changeDetector.markForCheck();
      },
      error: error => {
        this.errorMessage = error.error?.message || 'Unable to load campaign history.';
        this.changeDetector.markForCheck();
      }
    });
  }

  showCampaignDetails(campaign: any, page = 1): void {
    this.detailsCampaign = campaign;
    this.detailPage = page;
    this.service.campaign(campaign._id, page).subscribe({
      next: response => {
        this.detailsCampaign = response.campaign;
        this.detailRecipients = response.recipients || [];
        this.detailSummary = response.summary || this.emptySummary();
        this.detailTotalPages = Number(response.pagination?.totalPages || 0);
        this.changeDetector.markForCheck();
      },
      error: error => {
        this.errorMessage = error.error?.message || 'Unable to load recipient progress.';
        this.changeDetector.markForCheck();
      }
    });
  }

  startExistingCampaign(campaign: any): void {
    this.updateCampaignStatus(campaign._id, 'IN_PROGRESS', 'Campaign resumed.');
  }

  pauseCampaign(): void {
    if (this.activeCampaign) this.updateCampaignStatus(this.activeCampaign._id, 'PAUSED', 'Campaign paused.');
  }

  resumeCampaign(): void {
    if (this.activeCampaign) this.updateCampaignStatus(this.activeCampaign._id, 'IN_PROGRESS', 'Campaign resumed.');
  }

  stopCampaign(): void {
    if (!this.activeCampaign) return;
    const confirmed = window.confirm('Stop this campaign? Pending recipients will remain unprocessed and cannot be resumed.');
    if (confirmed) this.updateCampaignStatus(this.activeCampaign._id, 'STOPPED', 'Campaign stopped.');
  }

  private updateCampaignStatus(id: string, status: string, success: string): void {
    this.actionLoading = true;
    this.errorMessage = '';
    this.service.updateCampaignStatus(id, status)
      .pipe(finalize(() => {
        this.actionLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: () => {
          this.successMessage = success;
          this.loadCampaign(id);
          this.loadHistory(this.historyPage);
        },
        error: error => {
          this.errorMessage = error.error?.message || 'Unable to update campaign.';
        }
      });
  }

  openWhatsApp(): void {
    if (this.actionLoading || !this.activeCampaign || !this.currentRecipient ||
      this.currentRecipient.status !== 'PENDING') return;
    let url = '';
    try {
      url = createWhatsAppUrl(
        this.currentRecipient.mobile,
        this.campaignMessage(this.currentRecipient)
      );
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'This member has an invalid mobile number.';
      return;
    }
    const chatWindow = window.open(url, '_blank');
    if (!chatWindow) {
      this.errorMessage = 'WhatsApp was blocked by your browser. Allow pop-ups for this site and click Open WhatsApp again.';
      return;
    }
    chatWindow.opener = null;
    this.updateRecipient('WHATSAPP_OPENED', 'WhatsApp opened. Send the message manually, then return here to mark it as sent.');
  }

  markAsSent(): void {
    this.updateRecipient('MANUALLY_MARKED_SENT', 'Manual confirmation recorded. Click Next Member to continue.');
  }

  skipMember(): void {
    if (!this.currentRecipient) return;
    this.updateRecipient('SKIPPED', 'Member skipped. Click Next Member to continue.');
  }

  nextMember(): void {
    if (this.actionLoading || !this.activeCampaign) return;
    this.actionLoading = true;
    this.service.advanceCampaign(this.activeCampaign._id)
      .pipe(finalize(() => {
        this.actionLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: () => {
          this.loadCampaign(this.activeCampaign._id);
          this.loadHistory(this.historyPage);
        },
        error: error => {
          this.errorMessage = error.error?.message || 'Unable to move to the next member.';
        }
      });
  }

  private updateRecipient(status: string, success: string): void {
    if (this.actionLoading || !this.activeCampaign || !this.currentRecipient) return;
    this.actionLoading = true;
    this.errorMessage = '';
    this.service.updateRecipient(
      this.activeCampaign._id,
      this.currentRecipient.memberId,
      status
    ).pipe(finalize(() => {
      this.actionLoading = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: () => {
        this.successMessage = success;
        this.loadCampaign(this.activeCampaign._id);
        this.loadHistory(this.historyPage);
      },
      error: error => {
        this.errorMessage = error.error?.message || 'Unable to record recipient progress.';
      }
    });
  }

  campaignMessage(recipient: any): string {
    return personalizeGlobalMessage(this.activeCampaign?.message || '', {
      _id: String(recipient.memberId),
      fullName: recipient.memberName || '',
      phone: recipient.mobile || '',
      normalizedMobile: recipient.mobile || '',
      membership: recipient.expiryDate ? { endDate: recipient.expiryDate } : null,
      planName: recipient.planName || '',
      pendingAmount: recipient.pendingAmount || 0
    }, this.gymName, this.timeZone);
  }

  statusLabel(status: string): string {
    return ({
      DRAFT: 'Draft',
      IN_PROGRESS: 'In Progress',
      PAUSED: 'Paused',
      COMPLETED: 'Completed',
      STOPPED: 'Stopped',
      PENDING: 'Pending',
      WHATSAPP_OPENED: 'WhatsApp opened',
      MANUALLY_MARKED_SENT: 'Manually marked sent',
      SKIPPED: 'Skipped',
      INVALID_NUMBER: 'Invalid number'
    } as Record<string, string>)[status] || status;
  }

  formatDate(date: string | Date | null | undefined): string {
    if (!date) return '—';
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime())
      ? '—'
      : new Intl.DateTimeFormat('en-IN', {
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        }).format(parsed);
  }

  private emptySummary(): CampaignSummary {
    return {
      totalRecipients: 0,
      whatsappOpened: 0,
      manuallyMarkedSent: 0,
      skipped: 0,
      invalidNumber: 0,
      pending: 0
    };
  }
}
