//////////////////////////////////////////////////////////////////////////////////
// Module Name: uart_byte_rx
//
// 功能：
//   UART 单字节接收模块
//
// 系统时钟：
//   50 MHz
//
// UART格式：
//   8N1
//
// baud_set：
//   0 -> 9600
//   1 -> 19200
//   2 -> 38400
//   3 -> 57600
//   4 -> 115200
//
// 工作流程：
//   1. 检测 UART_RX 下降沿
//   2. 延时半个 Bit，确认 Start Bit 仍为低电平
//   3. 每隔一个 Bit 周期，在数据中心采样
//   4. 依次接收 D0 ~ D7
//   5. 检查 Stop Bit
//   6. 接收成功后：
//          data_byte 输出数据
//          rx_Done 拉高一个 clk 周期
//
// 注意：
//   UART数据位为低位先发送。
//   本模块接口保持与原 uart_byte_rx 相同，
//   原 uart_data_rx 仍可以继续使用。
//////////////////////////////////////////////////////////////////////////////////

module uart_byte_rx(
    clk,
    rst_n,

    baud_set,
    uart_rx,

    data_byte,
    rx_Done
);

    input             clk;
    input             rst_n;

    input      [2:0]  baud_set;
    input             uart_rx;

    output reg [7:0]  data_byte;
    output reg        rx_Done;


    // ============================================================
    // UART RX 输入同步
    //
    // UART_RX 与 FPGA 时钟异步，因此使用两级寄存器同步
    // ============================================================

    reg uart_rx_sync1;
    reg uart_rx_sync2;

    reg uart_rx_prev;


    // 下降沿检测
    wire uart_rx_nedge;


    always @(posedge clk or negedge rst_n)
    begin

        if (!rst_n)
        begin

            uart_rx_sync1 <= 1'b1;
            uart_rx_sync2 <= 1'b1;
            uart_rx_prev  <= 1'b1;

        end

        else
        begin

            uart_rx_sync1 <= uart_rx;

            uart_rx_sync2 <= uart_rx_sync1;

            uart_rx_prev <= uart_rx_sync2;

        end

    end


    assign uart_rx_nedge =
        uart_rx_prev
        &
        (~uart_rx_sync2);


    // ============================================================
    // 波特率分频
    //
    // baud_div表示一个UART Bit需要多少个50MHz时钟周期
    //
    // 50MHz / 115200 ≈ 434
    // ============================================================

    reg [15:0] baud_div;


    always @(*)
    begin

        case (baud_set)

            3'd0:
                baud_div = 16'd5208;     // 9600

            3'd1:
                baud_div = 16'd2604;     // 19200

            3'd2:
                baud_div = 16'd1302;     // 38400

            3'd3:
                baud_div = 16'd868;      // 57600

            3'd4:
                baud_div = 16'd434;      // 115200

            default:
                baud_div = 16'd5208;

        endcase

    end


    // ============================================================
    // 状态机
    // ============================================================

    localparam [1:0]

        S_IDLE  = 2'd0,

        S_START = 2'd1,

        S_DATA  = 2'd2,

        S_STOP  = 2'd3;


    reg [1:0] state;


    // UART bit时间计数器
    reg [15:0] baud_cnt;


    // 当前接收到第几个数据Bit
    reg [2:0] bit_index;


    // 临时数据
    reg [7:0] data_shift;


    // ============================================================
    // UART RX 主状态机
    // ============================================================

    always @(posedge clk or negedge rst_n)
    begin

        if (!rst_n)
        begin

            data_byte <= 8'd0;

            rx_Done <= 1'b0;


            baud_cnt <= 16'd0;

            bit_index <= 3'd0;

            data_shift <= 8'd0;


            state <= S_IDLE;

        end


        else
        begin

            // rx_Done只保持一个clk
            rx_Done <= 1'b0;


            case (state)


                // =================================================
                // 等待 Start Bit
                // =================================================

                S_IDLE:
                begin

                    baud_cnt <= 16'd0;

                    bit_index <= 3'd0;


                    // UART空闲为1
                    //
                    // 检测到下降沿，可能进入Start Bit
                    if (uart_rx_nedge)
                    begin

                        baud_cnt <= 16'd0;

                        state <= S_START;

                    end

                end


                // =================================================
                // Start Bit 中心确认
                //
                // 下降沿之后等待半个Bit
                //
                // 如果此时仍然是0：
                //      Start Bit有效
                //
                // 如果已经变回1：
                //      认为是干扰
                // =================================================

                S_START:
                begin

                    if (
                        baud_cnt
                        >=
                        ((baud_div >> 1) - 16'd1)
                    )
                    begin

                        baud_cnt <= 16'd0;


                        // Start Bit有效
                        if (!uart_rx_sync2)
                        begin

                            bit_index <= 3'd0;

                            state <= S_DATA;

                        end


                        // 假下降沿
                        else
                        begin

                            state <= S_IDLE;

                        end

                    end


                    else
                    begin

                        baud_cnt <= baud_cnt + 16'd1;

                    end

                end


                // =================================================
                // 数据接收
                //
                // UART顺序：
                //
                // D0
                // D1
                // ...
                // D7
                //
                // =================================================

                S_DATA:
                begin

                    if (
                        baud_cnt
                        >=
                        (baud_div - 16'd1)
                    )
                    begin

                        baud_cnt <= 16'd0;


                        // 在每一个Bit中心采样
                        data_shift[bit_index]
                            <= uart_rx_sync2;


                        // D7接收完成
                        if (bit_index == 3'd7)
                        begin

                            state <= S_STOP;

                        end


                        else
                        begin

                            bit_index
                                <= bit_index + 3'd1;

                        end

                    end


                    else
                    begin

                        baud_cnt <= baud_cnt + 16'd1;

                    end

                end


                // =================================================
                // Stop Bit
                // =================================================

                S_STOP:
                begin

                    if (
                        baud_cnt
                        >=
                        (baud_div - 16'd1)
                    )
                    begin

                        baud_cnt <= 16'd0;


                        // Stop Bit应该为1
                        if (uart_rx_sync2)
                        begin

                            data_byte <= data_shift;

                            rx_Done <= 1'b1;

                        end


                        // 无论Stop Bit正确与否
                        // 都重新等待下一帧
                        state <= S_IDLE;

                    end


                    else
                    begin

                        baud_cnt <= baud_cnt + 16'd1;

                    end

                end


                // =================================================

                default:
                begin

                    state <= S_IDLE;

                end


            endcase

        end

    end


endmodule