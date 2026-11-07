import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface DatabaseStatus {
  success: boolean;
  connected: boolean | null;
  checkedAt: string;
  lastSuccessfulConnectionCheck: string | null;
  databaseErrorStatus: 'none' | 'unavailable';
  scope?: string;
  message?: string;
}

export interface DatabaseCollection {
  name: string;
  modelName: string;
  documentCount: number;
  estimatedSizeBytes: number | null;
  sharedDocumentCount: number | null;
  sizeUnavailableReason: string | null;
  indexCount: number;
  collectionType: string;
  tenantScoped: boolean;
  protected: boolean;
  protectionReason: string;
  managementMenu: string | null;
  managementCategory: ManagementCategory | null;
}

export type ManagementCategory = 'members' | 'trainersStaff' | 'expenses';

export interface ManagementRecord {
  _id: string;
  fullName?: string;
  name?: string;
  title?: string;
  category?: string;
  role?: string;
  status?: string;
  joiningDate?: string;
  expenseDate?: string;
  createdAt: string;
  amountMinor?: number;
  paidAmountMinor?: number;
}

export interface ManagementRecordsResponse {
  success: boolean;
  category: ManagementCategory;
  page: number;
  limit: number;
  total: number;
  records: ManagementRecord[];
}

export interface DeletePreviewResponse {
  success: boolean;
  category: ManagementCategory;
  matchingCount: number;
  selectedCount: number;
  filters: {
    from: string | null;
    to: string | null;
    status: string | null;
    search: string | null;
    ids: string[] | null;
  };
  records: ManagementRecord[];
  impact: Record<string, number | string>;
}

export interface DatabaseManagementAuditEntry {
  actorId: string;
  actorRole: string;
  category: ManagementCategory;
  operation: string;
  affectedRecordCount: number;
  filters: Record<string, unknown>;
  reason: string;
  status: 'PENDING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  createdAt: string;
}

export interface PlatformStorage {
  databaseName: string | null;
  databaseStats: {
    dataSizeBytes: number | null;
    storageSizeBytes: number | null;
    indexSizeBytes: number | null;
    documentCount: number | null;
    collectionCount: number | null;
    indexCount: number | null;
    averageDocumentSizeBytes: number | null;
  };
  atlasStorage: {
    configured: boolean;
    available: boolean;
    reason: string | null;
    measuredAt: string | null;
    clusterName: string | null;
    clusterTier: string | null;
    clusterType: string | null;
    usedBytes: number | null;
    freeBytes: number | null;
    capacityBytes: number | null;
    utilizationPercent: number | null;
  };
}

export interface TenantStorageSummary {
  scope: 'authenticated_tenant';
  refreshedAt: string;
  tenantDocumentCount: number;
  tenantCollectionCount: number;
  sharedCollectionIndexCount: number;
  dataSizeBytes: number | null;
  storageSizeBytes: number | null;
  indexSizeBytes: number | null;
  averageDocumentSizeBytes: number | null;
  atlasCapacityMonitoringConfigured: boolean;
  platformAdmin: boolean;
  platformStorage: PlatformStorage | null;
}

export interface DatabaseCollectionsResponse {
  success: boolean;
  scope: string;
  refreshedAt: string;
  collections: DatabaseCollection[];
}

export interface DatabaseCollectionDetails {
  name: string;
  modelName: string;
  documentCount: number;
  estimatedSizeBytes: number | null;
  sharedDocumentCount: number | null;
  collectionType: string;
  tenantScoped: boolean;
  indexes: Array<{
    name: string;
    keys: string[];
    unique: boolean;
    sparse: boolean;
    expiresAfterSeconds: number | null;
  }>;
}

export interface DatabaseRefreshResponse {
  success: boolean;
  scope: string;
  refreshedAt: string;
  summary: Omit<
    TenantStorageSummary,
    'scope' | 'refreshedAt' | 'platformAdmin' | 'platformStorage'
  >;
  collections: DatabaseCollection[];
}

export interface ManagementFilters {
  from?: string;
  to?: string;
  status?: string;
  search?: string;
}

@Injectable({
  providedIn: 'root'
})
export class DatabaseManagementService {
  private readonly apiUrl = `${environment.apiUrl}/system`;

  constructor(private readonly http: HttpClient) {}

  getDatabaseStatus(): Observable<DatabaseStatus> {
    return this.http.get<DatabaseStatus>(`${this.apiUrl}/database-status`);
  }

  getDatabaseStorage(): Observable<TenantStorageSummary> {
    return this.http.get<TenantStorageSummary>(`${this.apiUrl}/database-storage`);
  }

  getCollections(): Observable<DatabaseCollectionsResponse> {
    return this.http.get<DatabaseCollectionsResponse>(`${this.apiUrl}/collections`);
  }

  getCollectionStats(collectionName: string): Observable<{
    success: boolean;
    collection: DatabaseCollectionDetails;
  }> {
    return this.http.get<{ success: boolean; collection: DatabaseCollectionDetails }>(
      `${this.apiUrl}/collections/${encodeURIComponent(collectionName)}/stats`
    );
  }

  getRecords(
    category: ManagementCategory,
    page: number,
    filters: ManagementFilters
  ): Observable<ManagementRecordsResponse> {
    let params = new HttpParams().set('category', category).set('page', page);
    for (const [key, value] of Object.entries(filters)) {
      if (value) params = params.set(key, value);
    }
    return this.http.get<ManagementRecordsResponse>(
      `${this.apiUrl}/data-management/records`,
      { params }
    );
  }

  previewDelete(
    category: ManagementCategory,
    ids: string[],
    filters: ManagementFilters
  ): Observable<DeletePreviewResponse> {
    return this.http.post<DeletePreviewResponse>(
      `${this.apiUrl}/data-management/preview`,
      { category, ids, ...filters }
    );
  }

  deleteRecords(request: {
    category: ManagementCategory;
    ids: string[];
    filters: ManagementFilters;
    reason: string;
    confirmationText: string;
    expectedCount: number;
    requestId: string;
  }): Observable<{ success: boolean; status: string; deletedCount: number; message: string }> {
    return this.http.post<{ success: boolean; status: string; deletedCount: number; message: string }>(
      `${this.apiUrl}/data-management/delete`,
      request
    );
  }

  getManagementHistory(page = 1): Observable<{
    success: boolean;
    page: number;
    limit: number;
    total: number;
    history: DatabaseManagementAuditEntry[];
  }> {
    const params = new HttpParams().set('page', page);
    return this.http.get<{
      success: boolean;
      page: number;
      limit: number;
      total: number;
      history: DatabaseManagementAuditEntry[];
    }>(`${this.apiUrl}/data-management/history`, { params });
  }

  refreshDatabaseStorage(): Observable<DatabaseRefreshResponse> {
    return this.http.post<DatabaseRefreshResponse>(
      `${this.apiUrl}/database-storage/refresh`,
      {}
    );
  }
}
