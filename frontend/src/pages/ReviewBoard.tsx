/**
 * /reviews 毛茶审评
 * - 香气 / 汤色 / 滋味 / 叶底分项打分，按权重实时换算总分（消费 utils/tea）
 * - 审评凭证绑定当次工艺：登记时快照批次工艺版本号；做青 / 杀青 / 焙火任一参数保存后
 *   凭证失效，审评标为「待复评」并撤出拼配候选（原分仅留档），重新审评后恢复「有效」
 * - 按总分排序展示并标记拼配候选（凭证有效且总分 ≥ 85 才进入候选清单）
 * - 审评登记后自动把批次推进到「已审评」；支持筛选、编辑、删除确认与空数据引导
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, PlusOutlined, ProfileOutlined, ReloadOutlined } from '@ant-design/icons';
import FilterBar, { type FilterSelectConfig } from '../components/common/FilterBar';
import GradeTag from '../components/common/GradeTag';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import { useIdbTable } from '../hooks/useIdbTable';
import { useGardenStore } from '../stores/gardenStore';
import { filterReviews, useBatchStore } from '../stores/batchStore';
import { db } from '../utils/db';
import {
  BLEND_CANDIDATE_SCORE,
  REVIEW_SCORE_LABEL,
  REVIEW_WEIGHTS,
  type Review,
  type ReviewDraft,
} from '../types/review';
import { ROUTES } from '../router';
import {
  SCORE_BANDS,
  averageScore,
  batchLabel,
  isReviewCredentialValid,
  roundTo,
  scoreGrade,
  todayIso,
  weightedTotalScore,
} from '../utils/tea';

/** 空表单默认分项打分 */
const EMPTY_SCORES = { aroma: 88, liquorColor: 86, taste: 87, leafBase: 84 };

export default function ReviewBoard() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [form] = Form.useForm<ReviewDraft>();

  const gardens = useGardenStore((state) => state.gardens);
  const batches = useBatchStore((state) => state.batches);
  const reviewFilters = useBatchStore((state) => state.reviewFilters);
  const setReviewFilters = useBatchStore((state) => state.setReviewFilters);
  const resetReviewFilters = useBatchStore((state) => state.resetReviewFilters);
  const markBatchState = useBatchStore((state) => state.markBatchState);

  const reviewsTable = useIdbTable<Review>(db.reviews, {
    prefix: 'review',
    sort: (a, b) => b.totalScore - a.totalScore,
  });

  const [modalOpen, setModalOpen] = useState(false);
  const [editingReview, setEditingReview] = useState<Review | null>(null);
  const [previewScore, setPreviewScore] = useState(() => weightedTotalScore(EMPTY_SCORES));

  const gardenMap = useMemo(() => new Map(gardens.map((garden) => [garden.id, garden])), [gardens]);
  const batchMap = useMemo(() => new Map(batches.map((batch) => [batch.id, batch])), [batches]);
  const labelOfBatch = (batchId: string): string => {
    const batch = batchMap.get(batchId);
    if (!batch) return '未知批次';
    return batchLabel(batch, gardenMap.get(batch.gardenId)?.name);
  };

  /** 凭证是否对应当次工艺（状态字段 + 凭证号双重校验，防数据漂移） */
  const credentialOk = (row: Review): boolean =>
    row.status === '有效' && isReviewCredentialValid(row, batchMap.get(row.batchId));

  const rows = useMemo(
    () => filterReviews(reviewsTable.rows, batches, gardens, reviewFilters),
    [batches, gardens, reviewFilters, reviewsTable.rows],
  );

  const stats = useMemo(() => {
    const validRows = rows.filter(
      (review) => review.status === '有效' && isReviewCredentialValid(review, batchMap.get(review.batchId)),
    );
    const scores = validRows.map((review) => review.totalScore);
    const candidates = validRows.filter((review) => review.totalScore >= BLEND_CANDIDATE_SCORE).length;
    const best = scores.length > 0 ? Math.max(...scores) : 0;
    return {
      average: averageScore(scores),
      best,
      candidates,
      pending: rows.length - validRows.length,
      batchCovered: new Set(validRows.map((review) => review.batchId)).size,
    };
  }, [rows, batchMap]);

  const selectConfigs: FilterSelectConfig[] = [
    {
      key: 'gardenIds',
      label: '按山场筛选',
      options: gardens.map((garden) => ({ value: garden.id, label: garden.name })),
    },
    {
      key: 'batchIds',
      label: '按批次筛选',
      options: batches.map((batch) => ({ value: batch.id, label: labelOfBatch(batch.id) })),
      width: 240,
    },
    {
      key: 'bands',
      label: '按总分区间筛选',
      options: SCORE_BANDS.map((band) => ({ value: band.key, label: band.label })),
      width: 190,
    },
  ];

  const openModal = (review?: Review): void => {
    setEditingReview(review ?? null);
    setModalOpen(true);
    if (review) {
      form.setFieldsValue({
        batchId: review.batchId,
        reviewedAt: review.reviewedAt,
        aroma: review.aroma,
        liquorColor: review.liquorColor,
        taste: review.taste,
        leafBase: review.leafBase,
        blendNote: review.blendNote,
      });
      setPreviewScore(review.totalScore);
    } else {
      form.setFieldsValue({
        batchId: batches[0]?.id,
        reviewedAt: todayIso(),
        ...EMPTY_SCORES,
        blendNote: '',
      });
      setPreviewScore(weightedTotalScore(EMPTY_SCORES));
    }
  };

  const submit = async (values: ReviewDraft): Promise<void> => {
    const totalScore = weightedTotalScore({
      aroma: values.aroma,
      liquorColor: values.liquorColor,
      taste: values.taste,
      leafBase: values.leafBase,
    });
    // 审评凭证绑定该批次当次工艺版本：登记 / 重新审评即恢复「有效」，
    // 之后任一工序参数保存都会让凭证失效并重新标为「待复评」
    const boundVersion = batchMap.get(values.batchId)?.processVersion ?? 0;
    const payload: Omit<Review, 'id' | 'createdAt' | 'updatedAt'> = {
      batchId: values.batchId,
      reviewedAt: values.reviewedAt,
      aroma: values.aroma,
      liquorColor: values.liquorColor,
      taste: values.taste,
      leafBase: values.leafBase,
      totalScore,
      processVersion: boundVersion,
      status: '有效',
      blendNote: values.blendNote ?? '',
    };
    try {
      if (editingReview) {
        await reviewsTable.update(editingReview.id, payload);
        message.success(`审评记录已更新，加权总分 ${totalScore} 分（${scoreGrade(totalScore)}），凭证已绑定当次工艺`);
      } else {
        await reviewsTable.create(payload);
        message.success(`审评已登记，加权总分 ${totalScore} 分（${scoreGrade(totalScore)}），凭证已绑定当次工艺`);
      }
      const nextState = await markBatchState(values.batchId, '已审评');
      if (nextState) message.success(`批次工序状态已回写为「${nextState}」`);
      setModalOpen(false);
      setEditingReview(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '审评记录保存失败');
    }
  };

  const confirmDelete = (review: Review): void => {
    modal.confirm({
      title: `删除 ${labelOfBatch(review.batchId)} 的审评记录？`,
      content: '删除后该批次不再出现在拼配候选清单中（批次工序状态不回退，留档分数一并移除）。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await reviewsTable.remove(review.id);
          message.success('审评记录已删除');
        } catch (error) {
          message.error(error instanceof Error ? error.message : '删除失败');
        }
      },
    });
  };

  const buildCandidates = (): void => {
    if (stats.candidates === 0) {
      message.warning(`暂无凭证有效且总分 ≥ ${BLEND_CANDIDATE_SCORE} 分的毛茶，先完成（或重新）审评再生成候选清单`);
      return;
    }
    message.success(`已按总分排序生成 ${stats.candidates} 款拼配候选，正在跳转拼配方案页`);
    navigate(ROUTES.blending);
  };

  const scoreTitle = (key: keyof typeof REVIEW_WEIGHTS): string =>
    `${REVIEW_SCORE_LABEL[key]}（权重 ${roundTo(REVIEW_WEIGHTS[key] * 100, 0)}%）`;

  const columns: ColumnsType<Review> = [
    {
      title: '茶青批次',
      key: 'batch',
      width: 250,
      render: (_: unknown, row) => {
        const batch = batchMap.get(row.batchId);
        if (!batch) return <Tag color="red">批次已删除</Tag>;
        return (
          <Space size={6} wrap>
            <span>{batchLabel(batch, gardenMap.get(batch.gardenId)?.name)}</span>
            <GradeTag kind="tenderness" value={batch.tenderness} />
          </Space>
        );
      },
    },
    { title: '审评日期', dataIndex: 'reviewedAt', width: 110 },
    { title: scoreTitle('aroma'), dataIndex: 'aroma', width: 120 },
    { title: scoreTitle('liquorColor'), dataIndex: 'liquorColor', width: 120 },
    { title: scoreTitle('taste'), dataIndex: 'taste', width: 120 },
    { title: scoreTitle('leafBase'), dataIndex: 'leafBase', width: 120 },
    {
      title: '加权总分',
      dataIndex: 'totalScore',
      width: 200,
      defaultSortOrder: 'descend',
      sorter: (a, b) => a.totalScore - b.totalScore,
      render: (value: number) => (
        <Space size={8}>
          <GradeTag kind="score" value={value} />
          <Progress
            percent={Math.min(100, value)}
            size="small"
            showInfo={false}
            style={{ width: 60 }}
            strokeColor={{ from: '#95c98a', to: '#2f5136' }}
          />
        </Space>
      ),
    },
    {
      title: '凭证状态',
      key: 'credential',
      width: 120,
      render: (_: unknown, row) => {
        const ok = credentialOk(row);
        return (
          <Tooltip
            title={
              ok
                ? `凭证绑定工艺版本 v${row.processVersion}，分数可用于拼配`
                : '工艺参数已变更或缺少凭证：原分仅留档，需重新审评才能恢复候选资格'
            }
          >
            <span>
              <GradeTag kind="reviewStatus" value={ok ? '有效' : '待复评'} />
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: '拼配候选',
      key: 'candidate',
      width: 110,
      render: (_: unknown, row) => {
        if (!credentialOk(row)) return <Tag color="orange">待复评</Tag>;
        return row.totalScore >= BLEND_CANDIDATE_SCORE ? <Tag color="volcano">候选</Tag> : <Tag>未达线</Tag>;
      },
    },
    {
      title: '拼配去向',
      dataIndex: 'blendNote',
      width: 200,
      render: (value: string) => value || <Typography.Text type="secondary">未登记</Typography.Text>,
    },
    {
      title: '批次状态',
      key: 'state',
      width: 120,
      render: (_: unknown, row) => {
        const batch = batchMap.get(row.batchId);
        return batch ? <GradeTag kind="state" value={batch.state} /> : '—';
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 170,
      render: (_: unknown, row) => (
        <Space size={2} wrap>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openModal(row)}>
            编辑
          </Button>
          <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => confirmDelete(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            毛茶审评
          </Typography.Title>
          <div className="page-hint">
            香气 30% / 汤色 20% / 滋味 35% / 叶底 15% 加权换算总分；总分 ≥ {BLEND_CANDIDATE_SCORE} 分且凭证有效才进入拼配候选。
            做青 / 杀青 / 焙火任一参数保存后，该批次审评凭证立即失效并标为「待复评」（原分仅留档），重新审评后恢复。
          </div>
        </div>
        <Space wrap>
          <Button icon={<ProfileOutlined />} onClick={buildCandidates}>
            生成拼配候选清单
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void reviewsTable.refresh()}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()} disabled={batches.length === 0}>
            登记审评
          </Button>
        </Space>
      </div>

      <div className="stat-row">
        <StatBadge label="审评记录" value={rows.length} suffix={`/ ${reviewsTable.count}`} tone="primary" />
        <StatBadge
          label="平均总分"
          value={stats.average === null ? '—' : stats.average}
          suffix="分"
          tone="info"
          hint="仅统计凭证有效的审评"
        />
        <StatBadge label="最高总分" value={stats.best} suffix="分" tone="success" hint={`档位：${scoreGrade(stats.best)}`} />
        <StatBadge
          label="拼配候选"
          value={stats.candidates}
          suffix="款"
          tone="warning"
          hint={`凭证有效且总分 ≥ ${BLEND_CANDIDATE_SCORE} 分`}
        />
        <StatBadge
          label="待复评"
          value={stats.pending}
          suffix="条"
          tone={stats.pending > 0 ? 'danger' : 'default'}
          hint="工艺参数变更后凭证失效，原分仅留档"
        />
        <StatBadge label="覆盖批次" value={stats.batchCovered} suffix="个" />
      </div>

      <FilterBar
        value={reviewFilters}
        onChange={setReviewFilters}
        selects={selectConfigs}
        onReset={resetReviewFilters}
        placeholder="搜索批次 / 拼配去向 / 审评日期"
        extra={
          <Tooltip title="列表默认按加权总分从高到低排序，可点击表头切换">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当前排序：总分降序
            </Typography.Text>
          </Tooltip>
        }
      />

      {reviewsTable.error ? (
        <EmptyPanel size="small" title="本地数据读取失败" description={reviewsTable.error} secondaryText="重试" onSecondary={() => void reviewsTable.refresh()} />
      ) : rows.length === 0 ? (
        <EmptyPanel
          title={reviewsTable.count === 0 ? '还没有审评记录' : '没有命中筛选条件的审评记录'}
          description={
            reviewsTable.count === 0
              ? '焙火足火并退火后即可开汤审评：填四项分数，系统自动加权总分并标记拼配候选。'
              : '试试调整关键字、山场、批次或总分区间。'
          }
          actionText={reviewsTable.count === 0 ? '登记审评' : undefined}
          onAction={reviewsTable.count === 0 ? () => openModal() : undefined}
          secondaryText={reviewsTable.count === 0 ? undefined : '重置筛选'}
          onSecondary={reviewsTable.count === 0 ? undefined : resetReviewFilters}
        />
      ) : (
        <Card className="panel-card" loading={reviewsTable.loading}>
          <Table<Review> rowKey="id" size="small" dataSource={rows} columns={columns} pagination={{ pageSize: 8 }} scroll={{ x: 1500 }} />
        </Card>
      )}

      <Modal
        open={modalOpen}
        title={editingReview ? '编辑审评记录' : '登记毛茶审评'}
        okText={editingReview ? '保存' : '登记并推进状态'}
        cancelText="取消"
        onCancel={() => {
          setModalOpen(false);
          setEditingReview(null);
        }}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values: ReviewDraft) => void submit(values)}
          onValuesChange={(_changed, all) =>
            setPreviewScore(
              weightedTotalScore({
                aroma: all.aroma ?? 0,
                liquorColor: all.liquorColor ?? 0,
                taste: all.taste ?? 0,
                leafBase: all.leafBase ?? 0,
              }),
            )
          }
        >
          <Row gutter={12}>
            <Col span={14}>
              <Form.Item label="茶青批次" name="batchId" rules={[{ required: true, message: '请选择茶青批次' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={batches.map((batch) => ({
                    value: batch.id,
                    label: `${batchLabel(batch, gardenMap.get(batch.gardenId)?.name)} · ${batch.state}`,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item
                label="审评日期"
                name="reviewedAt"
                rules={[
                  { required: true, message: '请选择审评日期' },
                  { pattern: /^\d{4}-\d{2}-\d{2}$/, message: '日期格式需为 YYYY-MM-DD' },
                ]}
              >
                <Input placeholder="2025-07-12" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            {(['aroma', 'liquorColor', 'taste', 'leafBase'] as const).map((key) => (
              <Col span={12} key={key}>
                <Form.Item
                  label={scoreTitle(key)}
                  name={key}
                  rules={[
                    { required: true, message: `请填写${REVIEW_SCORE_LABEL[key]}得分` },
                    { type: 'number', min: 0, max: 100, message: '分项得分需在 0-100 之间' },
                  ]}
                >
                  <InputNumber min={0} max={100} step={0.5} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            ))}
          </Row>
          <Row gutter={12} align="middle">
            <Col span={12}>
              <Space>
                <Typography.Text strong>加权总分预览：</Typography.Text>
                <GradeTag kind="score" value={previewScore} />
              </Space>
            </Col>
            <Col span={12}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                总分由分项加权自动换算，无需手工填写
              </Typography.Text>
            </Col>
          </Row>
          <Form.Item
            label="拼配去向"
            name="blendNote"
            style={{ marginTop: 12 }}
            rules={[{ max: 80, message: '拼配去向不超过 80 个字' }]}
          >
            <Input.TextArea rows={2} placeholder="例如 拼配方案 A · 占 35%" allowClear />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
