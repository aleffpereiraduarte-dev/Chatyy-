import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as api from '../services/api';

// Email hooks
export function useEmails(folder, page) {
  return useQuery({
    queryKey: ['emails', folder, page],
    queryFn: () => api.getInbox(folder, page),
  });
}

// Chat hooks
export function useChatList() {
  return useQuery({
    queryKey: ['chatList'],
    queryFn: () => api.chatConversations(),
    staleTime: 30000,
  });
}

// Storage info
export function useStorageInfo() {
  return useQuery({
    queryKey: ['storageInfo'],
    queryFn: () => api.fileStorageInfo(),
    staleTime: 120000,
  });
}

// Plan info
export function usePlanInfo() {
  return useQuery({
    queryKey: ['planInfo'],
    queryFn: () => api.planInfo(),
    staleTime: 300000,
  });
}

// Unified search
export function useUnifiedSearch(query) {
  return useQuery({
    queryKey: ['unifiedSearch', query],
    queryFn: () => api.unifiedSearch(query),
    enabled: query.length >= 2,
    staleTime: 60000,
  });
}
