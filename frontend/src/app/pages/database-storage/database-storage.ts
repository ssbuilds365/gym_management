import { ChangeDetectorRef, Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize, forkJoin, switchMap } from 'rxjs';
import {
  DatabaseManagementAuditEntry,
  DatabaseCollection,
  DatabaseCollectionDetails,
  DatabaseManagementService,
  DatabaseStatus,
  DeletePreviewResponse,
  ManagementCategory,
  ManagementFilters,
  ManagementRecord,
  TenantStorageSummary
} from '../../services/database-management';

@Component({
  selector: 'app-database-storage',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './database-storage.html',
  styleUrl: './database-storage.scss'
})
export class DatabaseStorage implements OnInit {
  @Output() navigateToMenu = new EventEmitter<string>();

  loading = true;
  refreshing = false;
  errorMessage = '';
  status: DatabaseStatus | null = null;
  summary: TenantStorageSummary | null = null;
  collections: DatabaseCollection[] = [];
  searchText = '';
  sortBy: 'name' | 'documents' | 'size' = 'name';
  collectionPage = 1;
  readonly collectionPageSize = 10;
  collectionDetails: DatabaseCollectionDetails | null = null;
  collectionDetailsLoading = false;
  collectionDetailsError = '';
  managementOpen = false;
  activeManagementCollection: DatabaseCollection | null = null;
  readonly managementCategories: Array<{ value: ManagementCategory; label: string }> = [
    { value: 'members', label: 'Members' },
    { value: 'trainersStaff', label: 'Trainers & Staff' },
    { value: 'expenses', label: 'Expenses' }
  ];
  managementCategory: ManagementCategory = 'members';
  managementLoading = false;
  managementError = '';
  managementSuccess = '';
  managementRecords: ManagementRecord[] = [];
  managementPage = 1;
  managementTotal = 0;
  readonly managementPageSize = 20;
  recordSearch = '';
  statusFilter = '';
  dateFrom = '';
  dateTo = '';
  selectedIds = new Set<string>();
  previewLoading = false;
  previewError = '';
  preview: DeletePreviewResponse | null = null;
  deleteReason = '';
  deleteConfirmation = '';
  deleting = false;
  historyLoading = false;
  historyError = '';
  history: DatabaseManagementAuditEntry[] = [];
  historyPage = 1;
  historyTotal = 0;

  constructor(
    private readonly databaseManagement: DatabaseManagementService,
    private readonly changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.load();
    this.loadHistory();
  }

  get filteredCollections(): DatabaseCollection[] {
    const search = this.searchText.trim().toLocaleLowerCase();
    const filtered = this.collections.filter(collection =>
      collection.name.toLocaleLowerCase().includes(search)
      || collection.modelName.toLocaleLowerCase().includes(search)
    );

    if (this.sortBy === 'documents') {
      return filtered.sort((left, right) =>
        right.documentCount - left.documentCount || left.name.localeCompare(right.name)
      );
    }
    if (this.sortBy === 'size') {
      return filtered.sort((left, right) =>
        (right.estimatedSizeBytes ?? -1) - (left.estimatedSizeBytes ?? -1)
        || left.name.localeCompare(right.name)
      );
    }
    return filtered.sort((left, right) => left.name.localeCompare(right.name));
  }

  get pagedCollections(): DatabaseCollection[] {
    const start = (this.collectionPage - 1) * this.collectionPageSize;
    return this.filteredCollections.slice(start, start + this.collectionPageSize);
  }

  get totalCollectionPages(): number {
    return Math.max(1, Math.ceil(this.filteredCollections.length / this.collectionPageSize));
  }

  get selectedCount(): number {
    return this.selectedIds.size;
  }

  get totalManagementPages(): number {
    return Math.max(1, Math.ceil(this.managementTotal / this.managementPageSize));
  }

  get managementStatuses(): string[] {
    if (this.managementCategory === 'members') return ['Active', 'Inactive', 'On Hold'];
    if (this.managementCategory === 'trainersStaff') return ['Active', 'Inactive'];
    return ['PAID', 'PENDING', 'PARTIALLY_PAID'];
  }

  get managementCategoryLabel(): string {
    return this.managementCategories.find(item => item.value === this.managementCategory)?.label
      || this.managementCategory;
  }

  load(): void {
    this.loading = true;
    this.errorMessage = '';
    this.checkConnection();

    forkJoin({
      summary: this.databaseManagement.getDatabaseStorage(),
      collectionResponse: this.databaseManagement.getCollections()
    })
      .pipe(finalize(() => {
        this.loading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: ({ summary, collectionResponse }) => {
          this.summary = summary;
          this.collections = collectionResponse.collections;
        },
        error: error => {
          console.error('Database storage loading error:', error);
          this.errorMessage = error.error?.message
            || 'Unable to load tenant database statistics. Try refreshing in a moment.';
        }
      });
  }

  refresh(): void {
    if (this.refreshing) return;
    this.refreshing = true;
    this.errorMessage = '';
    this.checkConnection();

    this.databaseManagement.refreshDatabaseStorage()
      .pipe(switchMap(() => forkJoin({
        summary: this.databaseManagement.getDatabaseStorage(),
        collectionResponse: this.databaseManagement.getCollections()
      })))
      .pipe(finalize(() => {
        this.refreshing = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: ({ summary, collectionResponse }) => {
          this.summary = summary;
          this.collections = collectionResponse.collections;
          this.collectionPage = Math.min(this.collectionPage, this.totalCollectionPages);
        },
        error: error => {
          console.error('Database storage refresh error:', error);
          this.errorMessage = error.error?.message
            || 'Unable to refresh tenant database statistics. Try again shortly.';
        }
      });
  }

  private checkConnection(): void {
    this.databaseManagement.getDatabaseStatus().subscribe({
      next: status => {
        this.status = status;
        this.changeDetector.markForCheck();
      },
      error: error => {
        if (error.error?.connected === false) {
          this.status = error.error as DatabaseStatus;
        } else {
          this.status = {
            success: false,
            connected: null,
            checkedAt: new Date().toISOString(),
            lastSuccessfulConnectionCheck: null,
            databaseErrorStatus: 'unavailable'
          };
        }
        this.changeDetector.markForCheck();
      }
    });
  }

  openWorkflow(menu: string | null): void {
    if (menu) this.navigateToMenu.emit(menu);
  }

  manageCollection(collection: DatabaseCollection): void {
    this.activeManagementCollection = collection;
    if (!collection.managementCategory || collection.protected) {
      this.viewCollectionDetails(collection);
      return;
    }

    this.managementCategory = collection.managementCategory;
    this.managementOpen = true;
    this.managementPage = 1;
    this.statusFilter = '';
    this.dateFrom = '';
    this.dateTo = '';
    this.recordSearch = '';
    this.selectedIds.clear();
    this.managementError = '';
    this.managementSuccess = '';
    this.loadRecords();
  }

  viewCollectionDetails(collection: DatabaseCollection): void {
    this.activeManagementCollection = collection;
    this.collectionDetails = null;
    this.collectionDetailsError = '';
    this.collectionDetailsLoading = true;
    this.databaseManagement.getCollectionStats(collection.name)
      .pipe(finalize(() => {
        this.collectionDetailsLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => this.collectionDetails = response.collection,
        error: error => {
          console.error('Collection detail loading error:', error);
          this.collectionDetailsError = error.error?.message || 'Unable to load collection details.';
        }
      });
  }

  closeCollectionDetails(): void {
    this.collectionDetails = null;
    this.collectionDetailsError = '';
    this.activeManagementCollection = null;
  }

  closeManagement(): void {
    if (this.deleting) return;
    this.managementOpen = false;
    this.selectedIds.clear();
    this.activeManagementCollection = null;
  }

  changeManagementCategory(category: ManagementCategory): void {
    this.managementCategory = category;
    this.statusFilter = '';
    this.dateFrom = '';
    this.dateTo = '';
    this.recordSearch = '';
    this.managementPage = 1;
    this.selectedIds.clear();
    this.loadRecords();
  }

  applyManagementFilters(): void {
    this.managementPage = 1;
    this.selectedIds.clear();
    this.managementSuccess = '';
    this.loadRecords();
  }

  loadRecords(): void {
    this.managementLoading = true;
    this.managementError = '';
    this.databaseManagement.getRecords(
      this.managementCategory,
      this.managementPage,
      this.currentFilters()
    )
      .pipe(finalize(() => {
        this.managementLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          this.managementRecords = response.records;
          this.managementTotal = response.total;
        },
        error: error => {
          console.error('Tenant data management records error:', error);
          this.managementError = error.error?.message || 'Unable to load records for this category.';
        }
      });
  }

  toggleRecord(id: string, selected: boolean): void {
    if (selected) {
      if (this.selectedIds.size >= 20) {
        this.managementError = 'Select no more than 20 records per deletion request.';
        return;
      }
      this.selectedIds.add(id);
    } else {
      this.selectedIds.delete(id);
    }
    this.managementError = '';
  }

  onRecordSelection(id: string, event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      this.toggleRecord(id, target.checked);
    }
  }

  goToManagementPage(page: number): void {
    if (page < 1 || page > this.totalManagementPages || page === this.managementPage) return;
    this.managementPage = page;
    this.selectedIds.clear();
    this.loadRecords();
  }

  previewDeletion(): void {
    if (this.selectedIds.size === 0 || this.previewLoading || this.deleting) return;
    this.previewLoading = true;
    this.previewError = '';
    this.deleteReason = '';
    this.deleteConfirmation = '';
    this.preview = null;
    this.databaseManagement.previewDelete(
      this.managementCategory,
      [...this.selectedIds],
      this.currentFilters()
    )
      .pipe(finalize(() => {
        this.previewLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: preview => {
          this.preview = preview;
          if (preview.selectedCount !== this.selectedIds.size) {
            this.previewError = 'Some records changed and are no longer available. Review the refreshed list.';
          }
        },
        error: error => {
          console.error('Database management delete preview error:', error);
          this.previewError = error.error?.message || 'Unable to preview this deletion.';
        }
      });
  }

  closePreview(): void {
    if (this.deleting) return;
    this.preview = null;
    this.previewError = '';
  }

  confirmDeletion(): void {
    if (!this.preview || this.deleting || this.deleteConfirmation !== 'DELETE'
        || this.deleteReason.trim().length < 8) return;

    this.deleting = true;
    this.previewError = '';
    this.databaseManagement.deleteRecords({
      category: this.managementCategory,
      ids: [...this.selectedIds],
      filters: this.currentFilters(),
      reason: this.deleteReason.trim(),
      confirmationText: this.deleteConfirmation,
      expectedCount: this.preview.selectedCount,
      requestId: globalThis.crypto.randomUUID()
    })
      .pipe(finalize(() => {
        this.deleting = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => this.finishDeletion(response.deletedCount, response.message),
        error: error => {
          console.error('Database management delete error:', error);
          if (error.error?.status === 'PARTIAL') {
            this.finishDeletion(
              Number(error.error.deletedCount || 0),
              'Some selected records were deleted; review the refreshed list and audit history.'
            );
            return;
          }
          if (Number(error.error?.deletedCount || 0) > 0) {
            this.finishDeletion(
              Number(error.error.deletedCount),
              error.error?.message || 'Check deletion history before retrying.'
            );
            return;
          }
          this.previewError = error.error?.message || 'The selected records were not deleted.';
          if (error.error?.code === 'PREVIEW_STALE') {
            this.preview = null;
            this.selectedIds.clear();
            this.loadRecords();
          }
        }
      });
  }

  loadHistory(): void {
    this.historyLoading = true;
    this.historyError = '';
    this.databaseManagement.getManagementHistory(this.historyPage)
      .pipe(finalize(() => {
        this.historyLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          this.history = this.historyPage === 1
            ? response.history
            : [...this.history, ...response.history];
          this.historyTotal = response.total;
        },
        error: error => {
          console.error('Database management audit history error:', error);
          this.historyError = error.error?.message || 'Unable to load deletion history.';
        }
      });
  }

  nextHistoryPage(): void {
    if (this.historyPage * 20 >= this.historyTotal) return;
    this.historyPage += 1;
    this.loadHistory();
  }

  recordLabel(record: ManagementRecord): string {
    return record.fullName || record.name || record.title || 'Record';
  }

  recordDate(record: ManagementRecord): string {
    return this.formatTimestamp(record.expenseDate || record.joiningDate || record.createdAt);
  }

  getStorageWarning(percentage: number | null | undefined): string {
    if (typeof percentage !== 'number' || !Number.isFinite(percentage)) return 'Unavailable';
    if (percentage >= 95) return 'Critical';
    if (percentage >= 85) return 'High';
    if (percentage >= 70) return 'Warning';
    return 'Normal';
  }

  hasImpact(impact: Record<string, number | string> | null | undefined): boolean {
    return Boolean(impact && Object.keys(impact).length);
  }

  private currentFilters(): ManagementFilters {
    return {
      ...(this.dateFrom ? { from: this.dateFrom } : {}),
      ...(this.dateTo ? { to: this.dateTo } : {}),
      ...(this.statusFilter ? { status: this.statusFilter } : {}),
      ...(this.recordSearch.trim() ? { search: this.recordSearch.trim() } : {})
    };
  }

  private finishDeletion(count: number, message: string): void {
    this.managementSuccess = `${count} record${count === 1 ? '' : 's'} deleted. ${message}`;
    this.selectedIds.clear();
    this.preview = null;
    this.previewError = '';
    this.loadRecords();
    this.historyPage = 1;
    this.history = [];
    this.loadHistory();
    this.refresh();
  }

  formatNumber(value: number | null | undefined): string {
    return typeof value === 'number' && Number.isFinite(value)
      ? new Intl.NumberFormat().format(value)
      : 'Unavailable';
  }

  formatBytes(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return 'Unavailable';
    }

    if (value === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const amount = value / (1024 ** unitIndex);
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(amount)} ${units[unitIndex]}`;
  }

  formatTimestamp(value: string | null | undefined): string {
    if (!value) return 'Not available';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Not available'
      : new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(date);
  }
}
